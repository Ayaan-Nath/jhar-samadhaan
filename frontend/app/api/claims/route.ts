import { NextRequest, NextResponse } from 'next/server';
import { getDbPool } from '../../../lib/db';

/* ============================================================================
 * /api/claims  (Module 4 — Academic Opportunities Marketplace)
 *
 * GET  /api/claims          -> { opportunities: Opportunity[] }
 *   Lists validated, active complaints available for adoption: complaints in
 *   'under_review' that are cluster heads (cluster_id IS NULL, so duplicate
 *   reports never clutter the board) and that have NOT been claimed yet.
 *   Each card carries its duplicate-cluster member count for severity.
 *
 * POST /api/claims           body: {
 *   complaintId: number,
 *   teamName: string,            (required)
 *   institutionName?: string,    (required by the UI; trimmed)
 *   teamLeadUserId: number,      (must exist and be an adoptable role)
 *   proposal: string,            (>= 20 characters, formal NEP 2020 approach)
 *   teamType?: 'student'|'ngo'|'institution'   (default 'student')
 * }
 *   -> 201 { claim: { id, complaintId, approvalStatus: 'pending', createdAt } }
 *
 * The INSERT relies on the claims table's UNIQUE(complaint_id) constraint so
 * only ONE claim can ever exist per complaint (-> 409 on collision) and the
 * column default sets approval_status = 'pending' for government review.
 * ==========================================================================*/

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* ----------------------------------------------------------------------------
 * Constants
 * -------------------------------------------------------------------------- */

const MIN_PROPOSAL_LENGTH = 20;
const MAX_LIST_LIMIT = 200;
const ADOPTABLE_ROLES = new Set(['student', 'ngo', 'institution']);
const VALID_TEAM_TYPES = new Set(['student', 'ngo', 'institution']);

/* ----------------------------------------------------------------------------
 * Types
 * -------------------------------------------------------------------------- */

interface OpportunityRow {
  id: number;
  title: string;
  description: string;
  category_code: string;
  category_label: string;
  district: string | null;
  latitude: number | null;
  longitude: number | null;
  cluster_members: string | number;
  created_at: Date;
}

interface ClaimInsertRow {
  id: number;
  approval_status: string;
  created_at: Date;
}

/* ----------------------------------------------------------------------------
 * GET — adoptable opportunities for the marketplace board
 * -------------------------------------------------------------------------- */

export async function GET() {
  let pool;
  try {
    pool = getDbPool();
  } catch (error) {
    console.error('[GET /api/claims] DB not configured:', error);
    return NextResponse.json(
      { error: 'Database is not configured. Set DATABASE_URL first.' },
      { status: 500 }
    );
  }

  try {
    const result = await pool.query<OpportunityRow>(
      `SELECT
         c.id,
         c.title,
         c.description,
         cat.code AS category_code,
         cat.name AS category_label,
         c.district,
         c.latitude::float8 AS latitude,
         c.longitude::float8 AS longitude,
         -- size of this complaint's duplicate cluster (0 when standalone)
         (SELECT count(*)::int
            FROM complaints m
           WHERE m.cluster_id = c.id) AS cluster_members,
         c.created_at
      FROM complaints c
      JOIN categories cat ON cat.id = c.category_id
      WHERE c.status = 'under_review'        -- validated by the admin triage
        AND c.cluster_id IS NULL             -- show cluster heads only
        AND NOT EXISTS (                     -- not already adopted
              SELECT 1 FROM claims cl WHERE cl.complaint_id = c.id
            )
      ORDER BY cluster_members DESC, c.created_at DESC
      LIMIT $1`,
      [MAX_LIST_LIMIT]
    );

    const opportunities = result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      category: { code: row.category_code, label: row.category_label },
      district: row.district,
      location:
        row.latitude !== null && row.longitude !== null
          ? { latitude: row.latitude, longitude: row.longitude }
          : null,
      clusterMembers: Number(row.cluster_members ?? 0),
      createdAt: row.created_at.toISOString(),
    }));

    return NextResponse.json({ opportunities });
  } catch (error) {
    console.error('[GET /api/claims] query failed:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to load opportunities: ${error.message}`
            : 'Failed to load opportunities.',
      },
      { status: 500 }
    );
  }
}

/* ----------------------------------------------------------------------------
 * POST — ingest a new adoption claim
 * -------------------------------------------------------------------------- */

export async function POST(request: NextRequest) {
  let pool;
  try {
    pool = getDbPool();
  } catch (error) {
    console.error('[POST /api/claims] DB not configured:', error);
    return NextResponse.json(
      { error: 'Database is not configured. Set DATABASE_URL first.' },
      { status: 500 }
    );
  }

  /* ---- parse + validate the payload --------------------------------------- */
  let complaintId: number;
  let teamName: string;
  let institutionName: string | null;
  let teamLeadUserId: number;
  let proposal: string;
  let teamType: string;

  try {
    const body = (await request.json()) as Record<string, unknown>;

    complaintId = Number(body.complaintId);
    if (!Number.isInteger(complaintId) || complaintId <= 0) {
      return NextResponse.json(
        { error: 'complaintId must be a positive integer.' },
        { status: 400 }
      );
    }

    teamName = typeof body.teamName === 'string' ? body.teamName.trim() : '';
    if (!teamName || teamName.length > 200) {
      return NextResponse.json(
        { error: 'Team name is required (max 200 characters).' },
        { status: 400 }
      );
    }

    institutionName =
      typeof body.institutionName === 'string' && body.institutionName.trim()
        ? body.institutionName.trim().slice(0, 200)
        : null;

    teamLeadUserId = Number(body.teamLeadUserId);
    if (!Number.isInteger(teamLeadUserId) || teamLeadUserId <= 0) {
      return NextResponse.json(
        { error: 'teamLeadUserId must be a positive integer.' },
        { status: 400 }
      );
    }

    proposal = typeof body.proposal === 'string' ? body.proposal.trim() : '';
    if (proposal.length < MIN_PROPOSAL_LENGTH) {
      return NextResponse.json(
        {
          error: `Proposal must be at least ${MIN_PROPOSAL_LENGTH} characters describing your technical approach under NEP 2020.`,
        },
        { status: 400 }
      );
    }

    teamType =
      typeof body.teamType === 'string' ? body.teamType.toLowerCase() : 'student';
    if (!VALID_TEAM_TYPES.has(teamType)) {
      return NextResponse.json(
        { error: 'teamType must be one of: student, ngo, institution.' },
        { status: 400 }
      );
    }
  } catch {
    return NextResponse.json(
      { error: 'Request body must be valid JSON.' },
      { status: 400 }
    );
  }

  try {
    /* ---- verify the problem is still adoptable ------------------------------ */
    const eligibility = await pool.query<{
      exists: boolean;
      status: string | null;
      already_claimed: boolean;
    }>(
      `SELECT
         c.id IS NOT NULL                                    AS exists,
         c.status,
         EXISTS (SELECT 1 FROM claims cl WHERE cl.complaint_id = c.id) AS already_claimed
      FROM complaints c
      WHERE c.id = $1`,
      [complaintId]
    );
    const check = eligibility.rows[0];

    if (!check || !check.exists) {
      return NextResponse.json(
        { error: `Complaint #${complaintId} was not found.` },
        { status: 404 }
      );
    }
    if (check.already_claimed) {
      return NextResponse.json(
        {
          error: `Complaint #${complaintId} has already been adopted by another team — only one active claim is allowed per problem.`,
        },
        { status: 409 }
      );
    }
    if (check.status !== 'under_review') {
      return NextResponse.json(
        {
          error: `Only validated problems (under_review) can be adopted. This complaint is currently "${check.status}".`,
        },
        { status: 409 }
      );
    }

    /* ---- verify the team lead is a real, adoptable user --------------------- */
    const lead = await pool.query<{ role: string }>(
      `SELECT role FROM users WHERE id = $1 AND is_active = TRUE LIMIT 1`,
      [teamLeadUserId]
    );
    if (!lead.rows[0]) {
      return NextResponse.json(
        { error: 'Team lead account was not found or is deactivated.' },
        { status: 400 }
      );
    }
    if (!ADOPTABLE_ROLES.has(lead.rows[0].role)) {
      return NextResponse.json(
        {
          error:
            'The team lead must be a student, NGO, or institution account to adopt a problem.',
        },
        { status: 400 }
      );
    }

    /* ---- INSERT (approval_status defaults to 'pending' in the schema) ------- */
    const insertResult = await pool.query<ClaimInsertRow>(
      `INSERT INTO claims (
           complaint_id, team_name, team_type, team_lead_id,
           institution_name, proposal
       ) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, approval_status, created_at`,
      [complaintId, teamName, teamType, teamLeadUserId, institutionName, proposal]
    );
    const claim = insertResult.rows[0];

    return NextResponse.json(
      {
        claim: {
          id: claim.id,
          complaintId,
          approvalStatus: claim.approval_status, // 'pending'
          createdAt: claim.created_at.toISOString(),
        },
        message:
          'Your proposal has been submitted to the government admin queue for review.',
      },
      { status: 201 }
    );
  } catch (error) {
    /* ---- surface constraint violations clearly ------------------------------ */
    const dbError = error as { code?: string; constraint?: string; message?: string };

    if (dbError.code === '23505') {
      // unique violation on claims.complaint_id -> only one claim per complaint
      return NextResponse.json(
        {
          error:
            'This problem has already been adopted by another team. Only one active claim is allowed per complaint.',
        },
        { status: 409 }
      );
    }
    if (dbError.code === '23503') {
      return NextResponse.json(
        { error: 'Referenced complaint or user does not exist.' },
        { status: 400 }
      );
    }
    if (dbError.code === '23514') {
      return NextResponse.json(
        {
          error: `Proposal must be at least ${MIN_PROPOSAL_LENGTH} characters (DB check).`,
        },
        { status: 400 }
      );
    }

    console.error('[POST /api/claims] insert failed:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to submit the claim: ${error.message}`
            : 'Failed to submit the claim.',
      },
      { status: 500 }
    );
  }
}
