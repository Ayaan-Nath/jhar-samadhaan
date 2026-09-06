import { NextRequest, NextResponse } from 'next/server';
import { getDbPool } from '../../../../lib/db';

/* ============================================================================
 * /api/industry/partnerships  (Module 5 — Industry & CSR Partnership Portal)
 *
 * GET  /api/industry/partnerships     header: x-user-id (industry OR govt_admin)
 *   -> { solutions: CatalogSolution[], metrics: ImpactMetrics }
 *   Lists govt-APPROVED academic prototypes available for industry backing,
 *   each joined to its adopting team, the source complaint, category, and live
 *   pledge aggregates. The response also carries aggregate corporate engagement
 *   metrics (committed INR, active pledges, partners, backing by type) that
 *   feed the state administrator impact dashboard. When the viewer is an
 *   industry account, their own pending/active pledges are attached per
 *   solution so the UI can show "Backed by you".
 *
 * POST /api/industry/partnerships     header: x-user-id (csr | startup | msme)
 *   body: {
 *     solutionId: number,
 *     pledgeType: 'grant' | 'mentorship' | 'pilot',
 *     amountInr?: number,     // required for grant, optional in-kind otherwise
 *     title: string,          // short commitment headline
 *     description: string     // >= 20 chars formal commitment
 *     contactEmail: string,   // point-of-contact (validated, required)
 *     contactPhone?: string   // optional point-of-contact phone
 *   }
 *   -> 201 { partnership, notified, message }
 *   Validates the corporate account (role csr/startup/msme), confirms the
 *   target prototype is govt-approved, INSERTs into partnerships with status
 *   'pending', and queues email notifications (type 'partnership') to the
 *   adopting team lead and every govt_admin — the SMTP worker drains those.
 *   uq_partnerships_partner_solution_type blocks duplicate pledges (409).
 * ==========================================================================*/

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* ----------------------------------------------------------------------------
 * Constants + helpers
 * -------------------------------------------------------------------------- */

const INDUSTRY_ROLES = new Set(['csr', 'startup', 'msme']);
const PARTNER_TYPE_LABEL: Record<string, string> = {
  csr: 'CSR entity',
  startup: 'Startup',
  msme: 'MSME',
};
const PLEDGE_TYPE_LABEL: Record<string, string> = {
  grant: 'Financial grant',
  mentorship: 'Technical mentorship',
  pilot: 'Pilot deployment',
};

const PLEDGE_TYPES = new Set(['grant', 'mentorship', 'pilot']);
const COMMITTED_STATUSES = ['pending', 'active', 'matched'];

const MAX_AMOUNT_INR = 999_999_999_999.99; // NUMERIC(14,2) ceiling
const MAX_TITLE_LENGTH = 200;
const MIN_DESCRIPTION_LENGTH = 20;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_CONTACT_EMAIL_LENGTH = 254;
const MAX_CONTACT_PHONE_LENGTH = 25;

const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const PHONE_PATTERN = /^[+0-9][0-9() -]{6,19}$/;

function isPositiveAmount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_AMOUNT_INR
  );
}

function formatInr(numeric: string | number | null): number {
  if (numeric === null || numeric === undefined) return 0;
  const value = Number(numeric);
  return Number.isFinite(value) ? value : 0;
}

/* ----------------------------------------------------------------------------
 * Types
 * -------------------------------------------------------------------------- */

interface CatalogRow {
  solution_id: number;
  iteration: number;
  title: string;
  summary: string;
  tech_stack: unknown;
  repository_url: string | null;
  prototype_url: string | null;
  submitted_at: Date;
  claim_id: number;
  team_name: string;
  team_type: string;
  institution_name: string | null;
  team_lead_name: string | null;
  complaint_id: number;
  complaint_title: string;
  complaint_district: string | null;
  category_code: string;
  category_name: string;
}

interface PledgeAggRow {
  solution_id: number;
  pledge_total: number;
  pledge_active: number;
  grant_pledges: number;
  mentorship_pledges: number;
  pilot_pledges: number;
  committed_inr: string | number;
}

interface MetricsRow {
  total: number;
  active: number;
  committed_inr: string | number;
  partners: number;
  backed_solutions: number;
  grants: number;
  mentorships: number;
  pilots: number;
  csr_pledges: number;
  startup_pledges: number;
  msme_pledges: number;
}

interface MyPledgeRow {
  solution_id: number;
  pledges: unknown; // jsonb array
}

interface SolutionCheckRow {
  status: string;
  complaint_id: number;
  team_lead_id: number | null;
}

interface AccountRow {
  role: string;
  org_name: string | null;
  full_name: string;
}

/* ----------------------------------------------------------------------------
 * GET — approved-solution catalog + engagement metrics
 * -------------------------------------------------------------------------- */

export async function GET(request: NextRequest) {
  const viewerId = Number(request.headers.get('x-user-id'));
  if (!Number.isInteger(viewerId) || viewerId <= 0) {
    return NextResponse.json(
      {
        error:
          'Missing or invalid x-user-id header. Industry partners and govt_admins may browse the marketplace.',
      },
      { status: 401 }
    );
  }

  let pool;
  try {
    pool = getDbPool();
  } catch (error) {
    console.error('[GET /api/industry/partnerships] DB not configured:', error);
    return NextResponse.json(
      { error: 'Database is not configured. Set DATABASE_URL first.' },
      { status: 500 }
    );
  }

  try {
    const account = await pool.query<AccountRow>(
      `SELECT role, org_name, full_name
         FROM users WHERE id = $1 AND is_active = TRUE LIMIT 1`,
      [viewerId]
    );
    const viewer = account.rows[0];
    if (!viewer) {
      return NextResponse.json(
        { error: 'Unknown or deactivated account.' },
        { status: 401 }
      );
    }
    const isIndustry = INDUSTRY_ROLES.has(viewer.role);
    const isAdmin = viewer.role === 'govt_admin';
    if (!isIndustry && !isAdmin) {
      return NextResponse.json(
        {
          error:
            'Only industry (csr/startup/msme) accounts or govt_admins may browse the partnership marketplace.',
        },
        { status: 403 }
      );
    }

    /* ---- A. approved-solution catalog -------------------------------------- */
    const catalogResult = await pool.query<CatalogRow>(
      `SELECT
         s.id               AS solution_id,
         s.iteration,
         s.title,
         s.summary,
         s.tech_stack,
         s.repository_url,
         s.prototype_url,
         s.submitted_at,
         cl.id              AS claim_id,
         cl.team_name,
         cl.team_type,
         cl.institution_name,
         u.full_name        AS team_lead_name,
         c.id               AS complaint_id,
         c.title            AS complaint_title,
         c.district         AS complaint_district,
         cat.code           AS category_code,
         cat.name           AS category_name
      FROM solutions s
      JOIN claims cl    ON cl.id = s.claim_id
      JOIN complaints c ON c.id = cl.complaint_id
      JOIN categories cat ON cat.id = c.category_id
      LEFT JOIN users u ON u.id = cl.team_lead_id
      WHERE s.status = 'approved'
      ORDER BY s.submitted_at DESC
      LIMIT 200`
    );

    /* ---- B. per-solution pledge aggregates (committed pledges only) --------- */
    const aggResult = await pool.query<PledgeAggRow>(
      `SELECT
         p.solution_id,
         count(*)::int AS pledge_total,
         count(*) FILTER (WHERE p.status IN ('active', 'matched'))::int AS pledge_active,
         count(*) FILTER (WHERE p.pledge_type = 'grant')::int      AS grant_pledges,
         count(*) FILTER (WHERE p.pledge_type = 'mentorship')::int AS mentorship_pledges,
         count(*) FILTER (WHERE p.pledge_type = 'pilot')::int      AS pilot_pledges,
         COALESCE(sum(p.amount_inr), 0) AS committed_inr
      FROM partnerships p
      WHERE p.status = ANY($1::text[])
      GROUP BY p.solution_id`,
      [COMMITTED_STATUSES]
    );
    const pledgeAgg = new Map<number, PledgeAggRow>();
    for (const row of aggResult.rows) pledgeAgg.set(row.solution_id, row);

    /* ---- C. impact metrics (all committed pledges) -------------------------- */
    const metricsResult = await pool.query<MetricsRow>(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE p.status IN ('active', 'matched'))::int AS active,
         COALESCE(sum(p.amount_inr), 0) AS committed_inr,
         count(DISTINCT p.partner_user_id)::int AS partners,
         count(DISTINCT p.solution_id)::int     AS backed_solutions,
         count(*) FILTER (WHERE p.pledge_type = 'grant')::int      AS grants,
         count(*) FILTER (WHERE p.pledge_type = 'mentorship')::int AS mentorships,
         count(*) FILTER (WHERE p.pledge_type = 'pilot')::int      AS pilots,
         count(*) FILTER (WHERE u.role = 'csr')::int     AS csr_pledges,
         count(*) FILTER (WHERE u.role = 'startup')::int AS startup_pledges,
         count(*) FILTER (WHERE u.role = 'msme')::int    AS msme_pledges
      FROM partnerships p
      JOIN users u ON u.id = p.partner_user_id
      WHERE p.status = ANY($1::text[])`,
      [COMMITTED_STATUSES]
    );
    const m = metricsResult.rows[0] ?? {
      total: 0,
      active: 0,
      committed_inr: 0,
      partners: 0,
      backed_solutions: 0,
      grants: 0,
      mentorships: 0,
      pilots: 0,
      csr_pledges: 0,
      startup_pledges: 0,
      msme_pledges: 0,
    };

    /* ---- D. viewer's own pledges (industry accounts) ------------------------ */
    const myPledges = new Map<number, unknown[]>();
    if (isIndustry) {
      const mineResult = await pool.query<MyPledgeRow>(
        `SELECT
           p.solution_id,
           json_agg(
             json_build_object(
               'id',         p.id,
               'pledgeType', p.pledge_type,
               'amountInr',  p.amount_inr,
               'status',     p.status,
               'createdAt',  p.created_at
             ) ORDER BY p.created_at DESC
           ) AS pledges
         FROM partnerships p
         WHERE p.partner_user_id = $1
           AND p.status = ANY($2::text[])
         GROUP BY p.solution_id`,
        [viewerId, COMMITTED_STATUSES]
      );
      for (const row of mineResult.rows) {
        myPledges.set(
          row.solution_id,
          Array.isArray(row.pledges) ? row.pledges : []
        );
      }
    }

    /* ---- assemble response -------------------------------------------------- */
    const solutions = catalogResult.rows.map((row) => {
      const agg = pledgeAgg.get(row.solution_id);
      return {
        solutionId: row.solution_id,
        iteration: row.iteration,
        title: row.title,
        summary: row.summary,
        techStack: Array.isArray(row.tech_stack) ? row.tech_stack : [],
        repositoryUrl: row.repository_url,
        prototypeUrl: row.prototype_url,
        submittedAt: row.submitted_at.toISOString(),
        team: {
          claimId: row.claim_id,
          teamName: row.team_name,
          teamType: row.team_type,
          institutionName: row.institution_name,
          teamLeadName: row.team_lead_name,
        },
        complaint: {
          id: row.complaint_id,
          title: row.complaint_title,
          district: row.complaint_district,
          categoryCode: row.category_code,
          categoryName: row.category_name,
        },
        pledges: {
          total: agg?.pledge_total ?? 0,
          active: agg?.pledge_active ?? 0,
          byType: {
            grant: agg?.grant_pledges ?? 0,
            mentorship: agg?.mentorship_pledges ?? 0,
            pilot: agg?.pilot_pledges ?? 0,
          },
          committedInr: formatInr(agg?.committed_inr ?? 0),
        },
        myPledges: myPledges.get(row.solution_id) ?? [],
      };
    });

    const metrics = {
      totalPledges: m.total,
      activePledges: m.active,
      committedInr: formatInr(m.committed_inr),
      partners: m.partners,
      backedSolutions: m.backed_solutions,
      byType: { grant: m.grants, mentorship: m.mentorships, pilot: m.pilots },
      byPartnerType: {
        csr: m.csr_pledges,
        startup: m.startup_pledges,
        msme: m.msme_pledges,
      },
    };

    return NextResponse.json({ solutions, metrics });
  } catch (error) {
    console.error('[GET /api/industry/partnerships] query failed:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to load the partnership marketplace: ${error.message}`
            : 'Failed to load the partnership marketplace.',
      },
      { status: 500 }
    );
  }
}

/* ----------------------------------------------------------------------------
 * POST — record an industry partnership pledge + notify the loop
 * -------------------------------------------------------------------------- */

export async function POST(request: NextRequest) {
  const partnerId = Number(request.headers.get('x-user-id'));
  if (!Number.isInteger(partnerId) || partnerId <= 0) {
    return NextResponse.json(
      {
        error:
          'Missing or invalid x-user-id header. A CSR/startup/MSME account is required to pledge.',
      },
      { status: 401 }
    );
  }

  let pool;
  try {
    pool = getDbPool();
  } catch (error) {
    console.error('[POST /api/industry/partnerships] DB not configured:', error);
    return NextResponse.json(
      { error: 'Database is not configured. Set DATABASE_URL first.' },
      { status: 500 }
    );
  }

  /* ---- parse + validate payload -------------------------------------------- */
  let solutionId: number;
  let pledgeType: string;
  let amountInr: number | null;
  let title: string;
  let description: string;
  let contactEmail: string;
  let contactPhone: string | null;

  try {
    const body = (await request.json()) as Record<string, unknown>;

    solutionId = Number(body.solutionId);
    if (!Number.isInteger(solutionId) || solutionId <= 0) {
      return NextResponse.json(
        { error: 'solutionId must be a positive integer.' },
        { status: 400 }
      );
    }

    pledgeType = typeof body.pledgeType === 'string' ? body.pledgeType : '';
    if (!PLEDGE_TYPES.has(pledgeType)) {
      return NextResponse.json(
        {
          error:
            'pledgeType must be one of: grant, mentorship, pilot.',
        },
        { status: 400 }
      );
    }

    // amount: required for grants, optional in-kind value otherwise
    if (body.amountInr === null || body.amountInr === undefined || body.amountInr === '') {
      amountInr = null;
    } else {
      const raw = Number(body.amountInr);
      if (!isPositiveAmount(raw)) {
        return NextResponse.json(
          {
            error: `amountInr must be a positive amount up to ${MAX_AMOUNT_INR.toLocaleString('en-IN')}.`,
          },
          { status: 400 }
        );
      }
      amountInr = Math.round(raw * 100) / 100; // 2-decimal precision
    }
    if (pledgeType === 'grant' && amountInr === null) {
      return NextResponse.json(
        {
          error:
            'A financial grant pledge must include the amount committed (amountInr, in INR).',
        },
        { status: 400 }
      );
    }

    title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      return NextResponse.json(
        { error: 'A short pledge title is required.' },
        { status: 400 }
      );
    }
    if (title.length > MAX_TITLE_LENGTH) {
      return NextResponse.json(
        { error: `Title must be at most ${MAX_TITLE_LENGTH} characters.` },
        { status: 400 }
      );
    }

    description =
      typeof body.description === 'string' ? body.description.trim() : '';
    if (description.length < MIN_DESCRIPTION_LENGTH) {
      return NextResponse.json(
        {
          error: `Description must be at least ${MIN_DESCRIPTION_LENGTH} characters outlining this formal commitment.`,
        },
        { status: 400 }
      );
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json(
        {
          error: `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`,
        },
        { status: 400 }
      );
    }

    contactEmail = typeof body.contactEmail === 'string' ? body.contactEmail.trim().toLowerCase() : '';
    if (contactEmail.length === 0) {
      return NextResponse.json(
        { error: 'A contact email is required so the adopting team and govt reviewers can reach your organisation.' },
        { status: 400 }
      );
    }
    if (contactEmail.length > MAX_CONTACT_EMAIL_LENGTH || !EMAIL_PATTERN.test(contactEmail)) {
      return NextResponse.json(
        { error: 'contactEmail must be a valid email address.' },
        { status: 400 }
      );
    }

    contactPhone =
      typeof body.contactPhone === 'string' && body.contactPhone.trim() !== ''
        ? body.contactPhone.trim()
        : null;
    if (
      contactPhone !== null &&
      (contactPhone.length > MAX_CONTACT_PHONE_LENGTH || !PHONE_PATTERN.test(contactPhone))
    ) {
      return NextResponse.json(
        { error: 'contactPhone must be a valid phone number (digits, spaces, +, - and parentheses only).' },
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

    /* ---- corporate credential check ----------------------------------------- */
    const accountResult = await client.query<AccountRow>(
      `SELECT role, org_name, full_name
         FROM users WHERE id = $1 AND is_active = TRUE LIMIT 1`,
      [partnerId]
    );
    const account = accountResult.rows[0];
    if (!account) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { error: 'Unknown or deactivated corporate account.' },
        { status: 401 }
      );
    }
    if (!INDUSTRY_ROLES.has(account.role)) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        {
          error:
            'Only CSR, startup, or MSME accounts (role csr/startup/msme) can make partnership pledges.',
        },
        { status: 403 }
      );
    }
    const partnerType = account.role;
    const partnerOrgName =
      account.org_name && account.org_name.trim() !== ''
        ? account.org_name.trim()
        : account.full_name;

    /* ---- target prototype must exist and be govt-approved ------------------- */
    const solutionCheck = await client.query<SolutionCheckRow>(
      `SELECT s.status, c.id AS complaint_id, cl.team_lead_id
         FROM solutions s
         JOIN claims cl    ON cl.id = s.claim_id
         JOIN complaints c ON c.id = cl.complaint_id
        WHERE s.id = $1 LIMIT 1`,
      [solutionId]
    );
    const solution = solutionCheck.rows[0];
    if (!solution) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { error: `Solution #${solutionId} was not found.` },
        { status: 404 }
      );
    }
    if (solution.status !== 'approved') {
      await client.query('ROLLBACK');
      return NextResponse.json(
        {
          error: `This prototype is "${solution.status}" — only govt-approved solutions can receive partnership pledges.`,
        },
        { status: 409 }
      );
    }
    if (solution.team_lead_id === partnerId) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { error: 'A team cannot fund its own prototype.' },
        { status: 409 }
      );
    }

    /* ---- INSERT the pledge (status defaults to 'pending') ------------------- */
    const insertResult = await client.query<{
      id: number;
      status: string;
      created_at: Date;
    }>(
      `INSERT INTO partnerships (
           solution_id, partner_user_id, pledge_type, amount_inr,
           title, description, contact_email, contact_phone, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
       RETURNING id, status, created_at`,
      [
        solutionId,
        partnerId,
        pledgeType,
        amountInr,
        title,
        description,
        contactEmail,
        contactPhone,
      ]
    );
    const pledge = insertResult.rows[0];

    /* ---- queue closed-loop notifications (team lead + govt admins) ----------- */
    const recipients = await client.query<{ id: number }>(
      `SELECT u.id
         FROM users u
        WHERE u.is_active = TRUE
          AND u.allow_email_alerts = TRUE
          AND (u.role = 'govt_admin' OR u.id = $1)
        ORDER BY u.id`,
      [solution.team_lead_id ?? -1]
    );
    const recipientIds = [
      ...new Set(recipients.rows.map((row) => row.id)),
    ];
    const amountText =
      pledgeType === 'grant' || amountInr !== null
        ? `₹${Number(amountInr ?? 0).toLocaleString('en-IN')} `
        : '';
    const subject = `New partnership pledge: ${PLEDGE_TYPE_LABEL[pledgeType]} for prototype #${solutionId}`;
    const body =
      `${partnerOrgName} (${PARTNER_TYPE_LABEL[partnerType]}) has pledged ` +
      `${amountText}support for the solution "${title}" on complaint #${solution.complaint_id}. ` +
      `Contact: ${partnerOrgName} <${contactEmail}>` +
      (contactPhone ? ` · ${contactPhone}` : '') +
      `. Review and match it in the industry partnerships queue.`;

    if (recipientIds.length > 0) {
      await client.query(
        `INSERT INTO notifications
             (user_id, complaint_id, type, channel, subject, body)
         SELECT u.id, $2, 'partnership', 'email', $3, $4
           FROM unnest($1::bigint[]) AS u(id)`,
        [recipientIds, solution.complaint_id, subject, body]
      );
    }

    await client.query('COMMIT');

    return NextResponse.json(
      {
        partnership: {
          id: pledge.id,
          solutionId,
          pledgeType,
          partnerType,
          amountInr,
          title,
          contactEmail,
          contactPhone,
          status: pledge.status, // 'pending'
          createdAt: pledge.created_at.toISOString(),
        },
        notified: recipientIds.length,
        message:
          'Pledge recorded! The adopting team and government admins have been notified — your commitment is pending matching.',
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
      // uq_partnerships_partner_solution_type
      return NextResponse.json(
        {
          error: `You already have a ${pledgeType} pledge on this solution. Update the existing pledge instead of duplicating it.`,
        },
        { status: 409 }
      );
    }
    if (dbError.code === '23514') {
      return NextResponse.json(
        {
          error:
            'Pledge violates a database rule (e.g. a financial grant must include an amount).',
        },
        { status: 400 }
      );
    }

    console.error('[POST /api/industry/partnerships] insert failed:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to record the pledge: ${error.message}`
            : 'Failed to record the pledge.',
      },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}
