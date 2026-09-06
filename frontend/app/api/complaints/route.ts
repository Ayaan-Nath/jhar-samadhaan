import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

/* ============================================================================
 * POST /api/complaints
 *
 * Consumes the multipart/form-data payload produced by CitizenIntakeForm.tsx
 * and inserts a new complaint (status defaults to 'submitted') into the
 * PostgreSQL `complaints` table via node-postgres.
 *
 * Expected form fields (mirror CitizenIntakeForm's IntakePayload):
 *   title             string   (5-300 chars)
 *   description       string   (>= 10 chars)
 *   privacy           'public' | 'anonymous'   (or isAnonymous=true|false)
 *   categoryCode      string   optional; falls back to the OTH category
 *   latitude          string   optional decimal (paired with longitude)
 *   longitude         string   optional decimal
 *   locationAccuracyM string   optional decimal (meters)
 *   photos[]          File     optional WebP files, each < 500 KB, max 4
 *
 * NOTE ON AUTH: `complaints.user_id` is NOT NULL. In production, resolve the
 * citizen from the authenticated session (e.g. NextAuth). Until auth is
 * wired, this handler accepts the numeric user id from the `x-user-id`
 * header or a `userId` form field - replace resolveUserId() before going live.
 *
 * Environment:
 *   DATABASE_URL          postgres://user:pass@host:5432/dbname (pgvector enabled)
 *   SBERT_SERVICE_URL     FastAPI triage microservice (default http://localhost:8000)
 *   DEDUPE_WINDOW_DAYS    how far back to search for duplicates (default 90)
 * ==========================================================================*/

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* ----------------------------------------------------------------------------
 * Constants (must match db/schema.sql + CitizenIntakeForm.tsx)
 * -------------------------------------------------------------------------- */

const MAX_PHOTOS = 4;
const MAX_PHOTO_BYTES = 500 * 1024; // strictly under 500 KB, enforced server-side too
const MIN_TITLE_LENGTH = 5;
const MAX_TITLE_LENGTH = 300;
const MIN_DESCRIPTION_LENGTH = 10;
const FALLBACK_CATEGORY_CODE = 'OTH';

// Semantic deduplication (pgvector + SBERT microservice)
const EMBEDDING_DIM = 384; // all-MiniLM-L6-v2 VECTOR(384)
const SIMILARITY_THRESHOLD = 0.82; // cosine similarity >= 0.82 counts as a duplicate
const SBERT_SERVICE_URL =
  process.env.SBERT_SERVICE_URL ?? 'http://localhost:8000';
const SBERT_TIMEOUT_MS = 10_000;
const MAX_EMBED_TEXT_LENGTH = 4000; // keep the request inside the model token window
const DEDUPE_WINDOW_DAYS = Number(process.env.DEDUPE_WINDOW_DAYS ?? 90) || 90;

/* ----------------------------------------------------------------------------
 * Singleton pg pool (survives hot reload in dev)
 * -------------------------------------------------------------------------- */

const globalForDb = globalThis as unknown as { pgPool?: Pool };

const pool =
  globalForDb.pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
  });

if (process.env.NODE_ENV !== 'production') globalForDb.pgPool = pool;

/* ----------------------------------------------------------------------------
 * Small types
 * -------------------------------------------------------------------------- */

interface StoredImage {
  fileName: string;
  url: string;
  size: number;
}

interface ComplaintInsertRow {
  id: number;
  status: string;
  created_at: Date;
}

interface CategoryRow {
  id: number;
  code: string;
}

interface DuplicateCandidateRow {
  id: number;
  similarity: number;
}

/* ----------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */

/**
 * Demo-only identity resolution.
 * TODO: replace with the real session (NextAuth / cookie) lookup so the
 * citizen id can never be spoofed by a client-supplied form field.
 */
async function resolveUserId(request: NextRequest): Promise<number | null> {
  const headerId = Number(request.headers.get('x-user-id'));
  if (Number.isInteger(headerId) && headerId > 0) return headerId;

  const formUserId = await request
    .clone()
    .formData()
    .then((form) => form.get('userId'))
    .catch(() => null);
  const parsed = Number(String(formUserId ?? ''));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function toOptionalNumber(raw: FormDataEntryValue | null): number | null {
  if (raw === null) return null;
  const value = Number(String(raw).trim());
  return Number.isFinite(value) ? value : null;
}

function isEmbeddingVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === EMBEDDING_DIM &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

function roundTo3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Calls Ayaan's FastAPI SBERT microservice to embed the complaint text.
 * Returns the 384-dim vector, or null when the service is down/unreachable so
 * intake degrades gracefully (the row is inserted without embedding/cluster).
 */
async function requestEmbedding(text: string): Promise<number[] | null> {
  const searchText = text.trim().slice(0, MAX_EMBED_TEXT_LENGTH);
  if (!searchText) return null;

  const url = `${SBERT_SERVICE_URL}/api/v1/embed`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SBERT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: searchText }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(
        `[POST /api/complaints] SBERT service returned ${response.status} from ${url}; inserting without embedding.`
      );
      return null;
    }
    const payload = (await response.json()) as { embedding?: unknown };
    if (!isEmbeddingVector(payload.embedding)) {
      console.error(
        `[POST /api/complaints] SBERT response missing a ${EMBEDDING_DIM}-dim embedding array; inserting without embedding.`
      );
      return null;
    }
    return payload.embedding;
  } catch (error) {
    // Network error / timeout / bad JSON: never block intake on the ML service.
    console.error(
      `[POST /api/complaints] Could not reach SBERT service at ${url}; inserting without embedding.`,
      error instanceof Error ? error.message : error
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function persistPhotos(complaintId: number, files: File[]): Promise<StoredImage[]> {
  const dir = path.join(
    process.cwd(),
    'public',
    'uploads',
    'complaints',
    String(complaintId)
  );
  await fs.mkdir(dir, { recursive: true });

  const stored: StoredImage[] = [];
  for (let i = 0; i < files.length; i += 1) {
    const buffer = Buffer.from(await files[i].arrayBuffer());
    const fileName = `${i + 1}-${crypto.randomUUID().slice(0, 8)}.webp`;
    await fs.writeFile(path.join(dir, fileName), buffer);
    stored.push({
      fileName,
      url: `/uploads/complaints/${complaintId}/${fileName}`,
      size: buffer.byteLength,
    });
  }
  return stored;
}

async function removePersistedPhotos(complaintId: number): Promise<void> {
  const dir = path.join(process.cwd(), 'public', 'uploads', 'complaints', String(complaintId));
  await fs.rm(dir, { recursive: true, force: true });
}

/* ----------------------------------------------------------------------------
 * POST handler
 * -------------------------------------------------------------------------- */

export async function POST(request: NextRequest) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: 'DATABASE_URL is not configured. Add it to the environment before submitting.' },
      { status: 500 }
    );
  }

  // ---- 1. parse + validate the multipart body -------------------------------
  if (!request.headers.get('content-type')?.includes('multipart/form-data')) {
    return NextResponse.json(
      { error: 'Expected multipart/form-data payload.' },
      { status: 400 }
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: 'Could not parse the multipart request body.' },
      { status: 400 }
    );
  }

  // ---- 2. identify the citizen ---------------------------------------------
  const userId = await resolveUserId(request);
  if (!userId) {
    return NextResponse.json(
      { error: 'Authentication required: could not resolve the reporting user.' },
      { status: 401 }
    );
  }

  // ---- 3. validate text fields (mirror the DB CHECK constraints) ------------
  const title = String(formData.get('title') ?? '').trim();
  if (title.length < MIN_TITLE_LENGTH || title.length > MAX_TITLE_LENGTH) {
    return NextResponse.json(
      { error: `Title must be between ${MIN_TITLE_LENGTH} and ${MAX_TITLE_LENGTH} characters.` },
      { status: 400 }
    );
  }

  const description = String(formData.get('description') ?? '').trim();
  if (description.length < MIN_DESCRIPTION_LENGTH) {
    return NextResponse.json(
      { error: `Description must be at least ${MIN_DESCRIPTION_LENGTH} characters.` },
      { status: 400 }
    );
  }

  // ---- 4. privacy toggle (accept the component's 'privacy' or isAnonymous) --
  const privacyRaw = String(formData.get('privacy') ?? '').trim().toLowerCase();
  const isAnonymous =
    privacyRaw === 'anonymous' || privacyRaw === 'true' || privacyRaw === '1'
      ? true
      : privacyRaw === 'public' || privacyRaw === 'false' || privacyRaw === '0'
        ? false
        : formData.get('isAnonymous') === 'true' || formData.get('isAnonymous') === '1';

  // ---- 5. coordinates (paired; both may be absent if permission denied) -----
  const latitude = toOptionalNumber(formData.get('latitude'));
  const longitude = toOptionalNumber(formData.get('longitude'));

  if ((latitude === null) !== (longitude === null)) {
    return NextResponse.json(
      { error: 'latitude and longitude must be provided together.' },
      { status: 400 }
    );
  }
  if (latitude !== null && (latitude < -90 || latitude > 90)) {
    return NextResponse.json({ error: 'latitude out of range.' }, { status: 400 });
  }
  if (longitude !== null && (longitude < -180 || longitude > 180)) {
    return NextResponse.json({ error: 'longitude out of range.' }, { status: 400 });
  }

  // ---- 6. WebP photo uploads (re-validate size/count server-side) -----------
  const photoFiles: File[] = [];
  for (const entry of formData.getAll('photos')) {
    if (!(entry instanceof File)) continue;
    const isWebp =
      entry.type === 'image/webp' || entry.name.toLowerCase().endsWith('.webp');
    if (!isWebp) {
      return NextResponse.json(
        { error: `"${entry.name}" is not a WebP image. Client compression must output WebP.` },
        { status: 400 }
      );
    }
    if (entry.size >= MAX_PHOTO_BYTES) {
      return NextResponse.json(
        { error: `"${entry.name}" exceeds the 500 KB limit.` },
        { status: 400 }
      );
    }
    photoFiles.push(entry);
  }
  if (photoFiles.length > MAX_PHOTOS) {
    return NextResponse.json(
      { error: `At most ${MAX_PHOTOS} photos are allowed per complaint.` },
      { status: 400 }
    );
  }

  // ---- 7. resolve category code -> categories.id ----------------------------
  const requestedCategoryCode =
    String(formData.get('categoryCode') ?? '').trim().toUpperCase() ||
    FALLBACK_CATEGORY_CODE;

  // ---- 8. embed complaint text via Ayaan's FastAPI SBERT microservice ---------
  // Semantic deduplication needs the 384-dim vector before we can search for
  // near-duplicates. If the microservice is down, embedding/cluster stay NULL
  // and the complaint is still stored.
  const embedding = await requestEmbedding(`${title}. ${description}`);

  // ---- 9. transaction: category lookup + dedupe + INSERT + audit log ---------
  const client = await pool.connect();
  let complaintId: number | null = null;

  try {
    await client.query('BEGIN');

    // Prefer the citizen's chosen category; fall back to the generic one.
    const categoryResult = await client.query<CategoryRow>(
      `SELECT id, code FROM categories WHERE code = $1 LIMIT 1`,
      [requestedCategoryCode]
    );
    let categoryId: number;
    let categoryCode: string;
    if (categoryResult.rows.length > 0) {
      categoryId = categoryResult.rows[0].id;
      categoryCode = categoryResult.rows[0].code;
    } else if (requestedCategoryCode !== FALLBACK_CATEGORY_CODE) {
      const fallback = await client.query<CategoryRow>(
        `SELECT id, code FROM categories WHERE code = $1 LIMIT 1`,
        [FALLBACK_CATEGORY_CODE]
      );
      if (fallback.rows.length === 0) {
        throw new Error(
          `Category seed missing: neither "${requestedCategoryCode}" nor "${FALLBACK_CATEGORY_CODE}" exist in categories. Run the seed script first.`
        );
      }
      categoryId = fallback.rows[0].id;
      categoryCode = fallback.rows[0].code;
    } else {
      throw new Error(
        `Category seed missing: "${FALLBACK_CATEGORY_CODE}" does not exist in categories. Run the seed script first.`
      );
    }

    // ---- semantic deduplication (pgvector HNSW cosine similarity) -----------
    // Search recent complaints for a near-duplicate. `<=>` returns cosine
    // DISTANCE, so similarity = 1 - distance; ORDER BY distance + LIMIT 1 is
    // accelerated by idx_complaints_embedding_hnsw. Only the new row's parent
    // gets the cluster_id; the parent complaint itself stays the cluster head.
    let clusterId: number | null = null;
    let clusterScore: number | null = null;
    if (embedding) {
      const embeddingLiteral = `[${embedding.join(',')}]`; // pgvector literal
      const duplicateResult = await client.query<DuplicateCandidateRow>(
        `SELECT id,
                1 - (embedding <=> $1::vector) AS similarity
           FROM complaints
          WHERE embedding IS NOT NULL
            AND created_at >= now() - make_interval(days => $2)
          ORDER BY embedding <=> $1::vector ASC
          LIMIT 1`,
        [embeddingLiteral, DEDUPE_WINDOW_DAYS]
      );
      const duplicate = duplicateResult.rows[0];
      if (duplicate && duplicate.similarity >= SIMILARITY_THRESHOLD) {
        clusterId = duplicate.id;
        clusterScore = roundTo3(duplicate.similarity);
      }
    }

    // Insert with the DB default status ('submitted'), the 384-dim embedding
    // passed as a pgvector literal ('[0.1,0.2,...]'::vector) and the cluster
    // link decided above (cluster_id NULL when no duplicate was found).
    const insertResult = await client.query<ComplaintInsertRow>(
      `INSERT INTO complaints (
           user_id, category_id, title, description,
           latitude, longitude,
           is_anonymous, submission_mode, images, embedding,
           cluster_id, cluster_score
       ) VALUES (
           $1, $2, $3, $4,
           $5, $6,
           $7, $8, $9::jsonb, $10::vector,
           $11, $12
       )
       RETURNING id, status, created_at`,
      [
        userId,
        categoryId,
        title,
        description,
        latitude,
        longitude,
        isAnonymous,
        photoFiles.length > 0 ? 'image' : 'text',
        JSON.stringify([]),
        embedding ? `[${embedding.join(',')}]` : null,
        clusterId,
        clusterScore,
      ]
    );
    const complaint = insertResult.rows[0];
    complaintId = complaint.id;

    // Persist the already-compressed WebP files to disk (under /public so they
    // are statically served), then store their metadata in the images JSONB.
    let storedImages: StoredImage[] = [];
    if (photoFiles.length > 0) {
      storedImages = await persistPhotos(complaint.id, photoFiles);
      await client.query(
        `UPDATE complaints SET images = $2::jsonb WHERE id = $1`,
        [complaint.id, JSON.stringify(storedImages)]
      );
    }

    // Initial audit entry so the workflow trail starts at 'submitted'.
    // (Subsequent transitions are written automatically by the DB trigger.)
    await client.query(
      `INSERT INTO status_logs (complaint_id, previous_status, new_status, changed_by)
       VALUES ($1, NULL, $2, $3)`,
      [complaint.id, complaint.status, userId]
    );

    await client.query('COMMIT');

    return NextResponse.json(
      {
        complaintId: complaint.id,
        status: complaint.status, // 'submitted'
        createdAt: complaint.created_at,
        category: { id: categoryId, code: categoryCode },
        isAnonymous,
        location:
          latitude !== null && longitude !== null
            ? { latitude, longitude }
            : null,
        cluster: clusterId
          ? { parentComplaintId: clusterId, similarity: clusterScore }
          : null,
        photos: storedImages,
      },
      { status: 201 }
    );
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // connection may already be broken - nothing left to roll back
    }
    // Best-effort cleanup of files written before the failure.
    if (complaintId !== null) {
      await removePersistedPhotos(complaintId).catch(() => undefined);
    }
    console.error('[POST /api/complaints] insert failed:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to store the complaint. Please try again.',
      },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}
