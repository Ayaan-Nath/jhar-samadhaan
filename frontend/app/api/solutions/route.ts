import { NextRequest, NextResponse } from 'next/server';
import { getDbPool } from '../../../lib/db';

/* ============================================================================
 * /api/solutions  (Module 6 — Solution Submission Portal)
 *
 * GET  /api/solutions      header: x-user-id  (team lead / solution owner)
 *   -> { claims: TeamClaim[] } — approved claims belonging to the user, each
 *   with its versioned solution submissions (iterations 1..N). Teams with no
 *   approved claim get an empty array.
 *
 * POST /api/solutions       header: x-user-id
 *   body: {
 *     claimId: number,
 *     title: string,                 (required)
 *     summary: string,               (>= 20 characters)
 *     techStack: string[],           (>= 1 item)
 *     documentation: { label?: string; url: string }[],  (optional, URL-validated)
 *     repositoryUrl?: string | null, (GitHub etc., must match http(s) URL regex)
 *     prototypeUrl?: string | null,  (live demo, URL-validated)
 *   }
 *   -> 201 { solution: { id, claimId, iteration, status: 'submitted', submittedAt } }
 *
 * Versioning: the next iteration is computed inside a transaction as
 * max(iteration)+1 for the claim, and INSERT respects the schema's
 * uq_solutions_claim_iteration UNIQUE(claim_id, iteration) constraint (a
 * concurrent duplicate surfaces as 409). status is set to 'submitted' and
 * submitted_at / submitted_by recorded, routing the documentation to the
 * govt_admin prototype-verification queue.
 * ==========================================================================*/

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* ----------------------------------------------------------------------------
 * Validation constants + helpers
 * -------------------------------------------------------------------------- */

const MIN_SUMMARY_LENGTH = 20;
const MAX_TITLE_LENGTH = 300;
const MAX_TECH_ITEMS = 20;
const MAX_TECH_ITEM_LENGTH = 60;
const MAX_DOC_LINKS = 10;

/** Loose but strict-enough http(s) URL check (host[:port][/path]). */
const URL_PATTERN = /^https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?(?:\/[^\s]*)?$/i;

function isUrl(value: unknown): value is string {
  return typeof value === 'string' && URL_PATTERN.test(value.trim());
}

function cleanNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/* ----------------------------------------------------------------------------
 * Types
 * -------------------------------------------------------------------------- */

interface TeamClaimRow {
  claim_id: number;
  complaint_id: number;
  complaint_title: string;
  team_name: string;
  submissions: unknown; // jsonb array, auto-parsed by node-postgres
}

interface SolutionInsertRow {
  id: number;
  iteration: number;
  status: string;
  submitted_at: Date;
}

/* ----------------------------------------------------------------------------
 * GET — approved claims + versioned submissions for the requesting team lead
 * -------------------------------------------------------------------------- */

export async function GET(request: NextRequest) {
  const userId = Number(request.headers.get('x-user-id'));
  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json(
      { error: 'Missing or invalid x-user-id header. Authentication required.' },
      { status: 401 }
    );
  }

  let pool;
  try {
    pool = getDbPool();
  } catch (error) {
    console.error('[GET /api/solutions] DB not configured:', error);
    return NextResponse.json(
      { error: 'Database is not configured. Set DATABASE_URL first.' },
      { status: 500 }
    );
  }

  try {
    const result = await pool.query<TeamClaimRow>(
      `SELECT
         cl.id AS claim_id,
         cl.complaint_id,
         c.title AS complaint_title,
         cl.team_name,
         COALESCE(json_agg(
           json_build_object(
             'id',            s.id,
             'iteration',     s.iteration,
             'title',         s.title,
             'summary',       s.summary,
             'techStack',     s.tech_stack,
             'documentation', s.documentation,
             'repositoryUrl', s.repository_url,
             'prototypeUrl',  s.prototype_url,
             'status',        s.status,
             'submittedAt',   s.submitted_at
           ) ORDER BY s.iteration
         ) FILTER (WHERE s.id IS NOT NULL), '[]'::json) AS submissions
      FROM claims cl
      JOIN complaints c ON c.id = cl.complaint_id
      LEFT JOIN solutions s ON s.claim_id = cl.id
      WHERE cl.team_lead_id = $1
        AND cl.approval_status = 'approved'
      GROUP BY cl.id, cl.complaint_id, c.title, cl.team_name
      ORDER BY cl.id`,
      [userId]
    );

    const claims = result.rows.map((row) => ({
      claimId: row.claim_id,
      complaintId: row.complaint_id,
      complaintTitle: row.complaint_title,
      teamName: row.team_name,
      submissions: Array.isArray(row.submissions) ? row.submissions : [],
    }));

    return NextResponse.json({ claims });
  } catch (error) {
    console.error('[GET /api/solutions] query failed:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to load your solutions: ${error.message}`
            : 'Failed to load your solutions.',
      },
      { status: 500 }
    );
  }
}

/* ----------------------------------------------------------------------------
 * POST — submit the next prototype iteration for a claim
 * -------------------------------------------------------------------------- */

export async function POST(request: NextRequest) {
  const userId = Number(request.headers.get('x-user-id'));
  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json(
      { error: 'Missing or invalid x-user-id header. Authentication required.' },
      { status: 401 }
    );
  }

  let pool;
  try {
    pool = getDbPool();
  } catch (error) {
    console.error('[POST /api/solutions] DB not configured:', error);
    return NextResponse.json(
      { error: 'Database is not configured. Set DATABASE_URL first.' },
      { status: 500 }
    );
  }

  /* ---- parse + validate payload -------------------------------------------- */
  let claimId: number;
  let title: string;
  let summary: string;
  let techStack: string[];
  let documentation: { label: string | null; url: string }[];
  let repositoryUrl: string | null;
  let prototypeUrl: string | null;

  try {
    const body = (await request.json()) as Record<string, unknown>;

    claimId = Number(body.claimId);
    if (!Number.isInteger(claimId) || claimId <= 0) {
      return NextResponse.json(
        { error: 'claimId must be a positive integer.' },
        { status: 400 }
      );
    }

    title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      return NextResponse.json(
        { error: 'A prototype title is required.' },
        { status: 400 }
      );
    }
    if (title.length > MAX_TITLE_LENGTH) {
      return NextResponse.json(
        { error: `Title must be at most ${MAX_TITLE_LENGTH} characters.` },
        { status: 400 }
      );
    }

    summary = typeof body.summary === 'string' ? body.summary.trim() : '';
    if (summary.length < MIN_SUMMARY_LENGTH) {
      return NextResponse.json(
        {
          error: `Summary must be at least ${MIN_SUMMARY_LENGTH} characters describing this iteration.`,
        },
        { status: 400 }
      );
    }

    // tech stack: JSON array of non-empty strings
    if (!Array.isArray(body.techStack)) {
      return NextResponse.json(
        { error: 'techStack must be an array of technology names.' },
        { status: 400 }
      );
    }
    techStack = body.techStack
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
    if (techStack.length === 0) {
      return NextResponse.json(
        { error: 'Add at least one technology to the tech stack.' },
        { status: 400 }
      );
    }
    if (techStack.length > MAX_TECH_ITEMS) {
      return NextResponse.json(
        { error: `Tech stack can hold at most ${MAX_TECH_ITEMS} items.` },
        { status: 400 }
      );
    }
    if (techStack.some((item) => item.length > MAX_TECH_ITEM_LENGTH)) {
      return NextResponse.json(
        {
          error: `Each tech stack item must be at most ${MAX_TECH_ITEM_LENGTH} characters.`,
        },
        { status: 400 }
      );
    }

    // documentation: array of { label?, url } (plain strings accepted too)
    if (!Array.isArray(body.documentation)) {
      return NextResponse.json(
        { error: 'documentation must be an array of links.' },
        { status: 400 }
      );
    }
    if (body.documentation.length > MAX_DOC_LINKS) {
      return NextResponse.json(
        { error: `At most ${MAX_DOC_LINKS} documentation links are allowed.` },
        { status: 400 }
      );
    }
    documentation = [];
    for (const entry of body.documentation) {
      if (typeof entry === 'string') {
        if (!isUrl(entry)) {
          return NextResponse.json(
            { error: `Invalid documentation URL: "${entry}". Use http(s) URLs.` },
            { status: 400 }
          );
        }
        documentation.push({ label: null, url: entry.trim() });
      } else if (entry && typeof entry === 'object') {
        const object = entry as { url?: unknown; label?: unknown };
        if (typeof object.url !== 'string' || !isUrl(object.url)) {
          return NextResponse.json(
            { error: 'Each documentation entry needs a valid http(s) url.' },
            { status: 400 }
          );
        }
        const label = cleanNullableString(object.label);
        documentation.push({ label, url: object.url.trim() });
      } else {
        return NextResponse.json(
          { error: 'Documentation entries must be URLs or { label, url } objects.' },
          { status: 400 }
        );
      }
    }

    repositoryUrl = cleanNullableString(body.repositoryUrl);
    if (repositoryUrl !== null && !isUrl(repositoryUrl)) {
      return NextResponse.json(
        {
          error: `Invalid repository URL: "${repositoryUrl}". Must be a valid http(s) URL (e.g. a GitHub repository).`,
        },
        { status: 400 }
      );
    }

    prototypeUrl = cleanNullableString(body.prototypeUrl);
    if (prototypeUrl !== null && !isUrl(prototypeUrl)) {
      return NextResponse.json(
        {
          error: `Invalid live demo URL: "${prototypeUrl}". Must be a valid http(s) URL.`,
        },
        { status: 400 }
      );
    }
  } catch {
    return NextResponse.json(
      { error: 'Request body must be valid JSON.' },
      { status: 400 }
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* ---- ownership + claim state check -------------------------------------- */
    const claimCheck = await client.query<{
      team_lead_id: number;
      approval_status: string;
    }>(
      `SELECT team_lead_id, approval_status
         FROM claims WHERE id = $1 LIMIT 1`,
      [claimId]
    );
    const claim = claimCheck.rows[0];
    if (!claim) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { error: `Claim #${claimId} was not found.` },
        { status: 404 }
      );
    }
    if (claim.team_lead_id !== userId) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { error: 'Only the team lead who owns this claim may submit solutions.' },
        { status: 403 }
      );
    }
    if (claim.approval_status !== 'approved') {
      await client.query('ROLLBACK');
      return NextResponse.json(
        {
          error: `This claim is "${claim.approval_status}" — only approved claims can submit prototype documentation.`,
        },
        { status: 409 }
      );
    }

    /* ---- compute next versioned iteration ----------------------------------- */
    const iterationResult = await client.query<{ next_iteration: string | number }>(
      `SELECT COALESCE(MAX(iteration), 0) + 1 AS next_iteration
         FROM solutions WHERE claim_id = $1`,
      [claimId]
    );
    const iteration = Number(iterationResult.rows[0].next_iteration ?? 1);

    /* ---- INSERT (status 'submitted', submitted_at now, submitted_by lead) ---- */
    const insertResult = await client.query<SolutionInsertRow>(
      `INSERT INTO solutions (
           claim_id, iteration, title, summary,
           tech_stack, documentation,
           repository_url, prototype_url,
           status, submitted_by, submitted_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, 'submitted', $9, now())
       RETURNING id, iteration, status, submitted_at`,
      [
        claimId,
        iteration,
        title,
        summary,
        JSON.stringify(techStack),
        JSON.stringify(documentation),
        repositoryUrl,
        prototypeUrl,
        userId,
      ]
    );
    const solution = insertResult.rows[0];

    await client.query('COMMIT');

    return NextResponse.json(
      {
        solution: {
          id: solution.id,
          claimId,
          iteration: solution.iteration,
          status: solution.status, // 'submitted'
          submittedAt: solution.submitted_at.toISOString(),
        },
        message:
          'Iteration submitted! The documentation has been routed to the government admin queue for prototype verification.',
      },
      { status: 201 }
    );
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // connection may already be broken
    }

    const dbError = error as { code?: string; constraint?: string };
    if (dbError.code === '23505') {
      // uq_solutions_claim_iteration — concurrent submission of same iteration
      return NextResponse.json(
        {
          error:
            'Iteration collision: another submission for this claim landed at the same time. Refresh and retry with the new iteration number.',
        },
        { status: 409 }
      );
    }

    console.error('[POST /api/solutions] insert failed:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to submit the solution: ${error.message}`
            : 'Failed to submit the solution.',
      },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}
