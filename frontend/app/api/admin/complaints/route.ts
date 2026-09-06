import { NextRequest, NextResponse } from 'next/server';
import { getDbPool } from '../../../../lib/db';

/* ============================================================================
 * GET /api/admin/complaints
 *
 * Powers the Government Admin Dashboard queue. Returns the recent complaints
 * joined with categories + users, respecting the is_anonymous privacy flag by
 * masking reporter identity server-side, and including duplicate-cluster
 * metadata (parent link + similarity + member count for cluster heads).
 *
 * Query params:
 *   limit   max rows to return (default 500, capped at 1000)
 *
 * Response: { complaints: AdminComplaint[] } — matches the shape consumed by
 * frontend/app/admin/complaints/page.tsx.
 * ==========================================================================*/

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Shape of a raw row returned by PostgreSQL. */
interface ComplaintRow {
  id: number;
  title: string;
  description: string;
  status: string;
  latitude: number | null;
  longitude: number | null;
  district: string | null;
  is_anonymous: boolean;
  images: unknown; // jsonb is auto-parsed by node-postgres
  cluster_id: number | null;
  cluster_score: number | null;
  status_reason: string | null;
  created_at: Date;
  updated_at: Date;
  category_code: string;
  category_label: string;
  reporter_id: number | null;
  reporter_name: string | null;
  cluster_members: string | number; // count(*) arrives as string via pg
}

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;
const ANONYMOUS_PLACEHOLDER = 'Anonymous Citizen';

export async function GET(request: NextRequest) {
  const adminId = Number(request.headers.get('x-admin-id'));
  if (!Number.isInteger(adminId) || adminId <= 0) {
    return NextResponse.json(
      { error: 'Missing or invalid x-admin-id header. Authentication required.' },
      { status: 401 }
    );
  }

  let pool;
  try {
    pool = getDbPool();
  } catch (error) {
    console.error('[GET /api/admin/complaints] DB not configured:', error);
    return NextResponse.json(
      { error: 'Database is not configured. Set DATABASE_URL first.' },
      { status: 500 }
    );
  }

  const requestedLimit = Number(request.nextUrl.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  try {
    /* ---- RBAC: must be an active govt_admin ---------------------------------- */
    const account = await pool.query<{ role: string }>(
      `SELECT role FROM users WHERE id = $1 AND is_active = TRUE LIMIT 1`,
      [adminId]
    );
    if (!account.rows[0]) {
      return NextResponse.json(
        { error: 'Unknown or deactivated admin account.' },
        { status: 401 }
      );
    }
    if (account.rows[0].role !== 'govt_admin') {
      return NextResponse.json(
        { error: 'Only govt_admin accounts may view the complaints queue.' },
        { status: 403 }
      );
    }

    const result = await pool.query<ComplaintRow>(
      `SELECT
         c.id,
         c.title,
         c.description,
         c.status,
         c.latitude::float8 AS latitude,
         c.longitude::float8 AS longitude,
         c.district,
         c.is_anonymous,
         c.images,
         c.cluster_id,
         c.cluster_score::float8 AS cluster_score,
         c.status_reason,
         c.created_at,
         c.updated_at,
         cat.code AS category_code,
         cat.name AS category_label,
         u.id   AS reporter_id,
         u.full_name AS reporter_name,
         -- how many complaints point at this row as their duplicate parent
         (SELECT count(*)::int
            FROM complaints m
           WHERE m.cluster_id = c.id) AS cluster_members
      FROM complaints c
      JOIN categories cat ON cat.id = c.category_id
      LEFT JOIN users u   ON u.id = c.user_id
      ORDER BY c.created_at DESC
      LIMIT $1`,
      [limit]
    );

    const complaints = result.rows.map((row) => {
      const location =
        row.latitude !== null && row.longitude !== null
          ? { latitude: row.latitude, longitude: row.longitude }
          : null;

      // PRIVACY: for anonymous complaints (or rows whose user no longer
      // exists) never leak the real identity — substitute a placeholder.
      let reporter: {
        isAnonymous: boolean;
        displayName: string | null;
      } | null = null;
      if (row.reporter_id !== null) {
        if (row.is_anonymous || !row.reporter_name) {
          reporter = { isAnonymous: true, displayName: ANONYMOUS_PLACEHOLDER };
        } else {
          reporter = { isAnonymous: false, displayName: row.reporter_name };
        }
      }

      return {
        id: row.id,
        title: row.title,
        description: row.description,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at?.toISOString(),
        category: { code: row.category_code, label: row.category_label },
        district: row.district,
        location,
        reporter,
        images: Array.isArray(row.images) ? row.images : [],
        cluster:
          row.cluster_id !== null
            ? { parentId: row.cluster_id, score: Number(row.cluster_score ?? 0) }
            : null,
        clusterMembers: Number(row.cluster_members ?? 0),
        statusReason: row.status_reason,
      };
    });

    return NextResponse.json({ complaints });
  } catch (error) {
    console.error('[GET /api/admin/complaints] query failed:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to load complaints: ${error.message}`
            : 'Failed to load complaints.',
      },
      { status: 500 }
    );
  }
}
