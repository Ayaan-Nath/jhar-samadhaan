import { NextRequest, NextResponse } from 'next/server';
import { getDbPool } from '../../../../lib/db';

/* ============================================================================
 * GET /api/admin/solutions  (Module 7 — verification queue)
 *
 * Lists prototype iterations for government reviewers, newest/needs-review
 * first, joined with the adopting claim (team, institution) and the linked
 * complaint. Supports an optional ?status= filter for tabbing.
 *
 * Response: { solutions: AdminSolutionView[] }
 * ==========================================================================*/

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_STATUSES = new Set([
  'draft',
  'submitted',
  'under_review',
  'approved',
  'rejected',
  'revision_requested',
]);

interface SolutionViewRow {
  id: number;
  iteration: number;
  title: string;
  summary: string;
  status: string;
  tech_stack: unknown;
  documentation: unknown;
  repository_url: string | null;
  prototype_url: string | null;
  submitted_at: Date;
  reviewed_by: number | null;
  reviewed_at: Date | null;
  review_comment: string | null;
  claim_id: number;
  team_name: string;
  team_type: string;
  institution_name: string | null;
  team_lead_name: string | null;
  complaint_id: number;
  complaint_title: string;
  complaint_status: string;
}

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
    console.error('[GET /api/admin/solutions] DB not configured:', error);
    return NextResponse.json(
      { error: 'Database is not configured. Set DATABASE_URL first.' },
      { status: 500 }
    );
  }

  const statusParam = request.nextUrl.searchParams.get('status');
  if (statusParam && !VALID_STATUSES.has(statusParam)) {
    return NextResponse.json(
      {
        error: `status filter must be one of: ${[...VALID_STATUSES].join(', ')}.`,
      },
      { status: 400 }
    );
  }

  try {
    const roleResult = await pool.query<{ role: string }>(
      `SELECT role FROM users WHERE id = $1 AND is_active = TRUE LIMIT 1`,
      [adminId]
    );
    if (!roleResult.rows[0]) {
      return NextResponse.json(
        { error: 'Unknown or deactivated admin account.' },
        { status: 401 }
      );
    }
    if (roleResult.rows[0].role !== 'govt_admin') {
      return NextResponse.json(
        { error: 'Only govt_admin accounts may view the verification queue.' },
        { status: 403 }
      );
    }

    const result = await pool.query<SolutionViewRow>(
      `SELECT
         s.id,
         s.iteration,
         s.title,
         s.summary,
         s.status,
         s.tech_stack,
         s.documentation,
         s.repository_url,
         s.prototype_url,
         s.submitted_at,
         s.reviewed_by,
         s.reviewed_at,
         s.review_comment,
         cl.id              AS claim_id,
         cl.team_name,
         cl.team_type,
         cl.institution_name,
         u.full_name        AS team_lead_name,
         c.id               AS complaint_id,
         c.title            AS complaint_title,
         c.status           AS complaint_status
      FROM solutions s
      JOIN claims cl    ON cl.id = s.claim_id
      JOIN complaints c ON c.id = cl.complaint_id
      LEFT JOIN users u ON u.id = cl.team_lead_id
      ${statusParam ? 'WHERE s.status = $1' : ''}
      ORDER BY
        (s.status IN ('submitted', 'revision_requested')) DESC,
        s.submitted_at DESC
      LIMIT 300`,
      statusParam ? [statusParam] : []
    );

    const solutions = result.rows.map((row) => ({
      id: row.id,
      iteration: row.iteration,
      title: row.title,
      summary: row.summary,
      status: row.status,
      techStack: Array.isArray(row.tech_stack) ? row.tech_stack : [],
      documentation: Array.isArray(row.documentation) ? row.documentation : [],
      repositoryUrl: row.repository_url,
      prototypeUrl: row.prototype_url,
      submittedAt: row.submitted_at.toISOString(),
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at?.toISOString() ?? null,
      reviewComment: row.review_comment,
      claim: {
        id: row.claim_id,
        teamName: row.team_name,
        teamType: row.team_type,
        institutionName: row.institution_name,
        teamLeadName: row.team_lead_name,
      },
      complaint: {
        id: row.complaint_id,
        title: row.complaint_title,
        status: row.complaint_status,
      },
    }));

    return NextResponse.json({ solutions });
  } catch (error) {
    console.error('[GET /api/admin/solutions] query failed:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to load the verification queue: ${error.message}`
            : 'Failed to load the verification queue.',
      },
      { status: 500 }
    );
  }
}
