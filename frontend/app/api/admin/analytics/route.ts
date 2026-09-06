import { NextRequest, NextResponse } from 'next/server';
import { getDbPool } from '../../../../lib/db';

/* ============================================================================
 * GET /api/admin/analytics  (State Administrator Analytics & Impact Dashboard)
 *
 * Header: x-admin-id  (must resolve to an active govt_admin)
 *
 * Query params (all optional):
 *   days      — look-back window in days for complaint activity   (default 365)
 *   district  — restrict to one district (exact match on complaints.district)
 *   category  — restrict to one domain category code (e.g. WAT, AGR, EDU)
 *
 * Aggregates complaints, claims, solutions and partnerships into clean JSON
 * scoped by district and domain:
 *   kpis        — macro headline metrics (submissions, open/resolved, duplicate
 *                 clustering, resolution latency, adoptions, funding, HEIs)
 *   statusCounts / domain-wise distribution with the innovation pipeline
 *                 (claims, approved prototypes)
 *   districts   — per-district performance table (resolution rate, avg days)
 *   pendency    — open-complaint age brackets (0-7 / 8-30 / 31-90 / 90+ days)
 *   trend       — monthly series of new complaints, resolutions and pledge ₹
 *   funding     — industry pledges by type (grant / mentorship / pilot)
 *   institutions/teamMix — institutional (HEI) participation analytics
 *
 * Scoping rule: complaint-centric metrics honour all three filters; pipeline
 * and funding metrics honour the days window plus district/category through
 * the source complaint (a pledge is only counted when its underlying complaint
 * is inside the selected scope).
 * ==========================================================================*/

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_DAYS = 3650;
const DEFAULT_DAYS = 365;

function clampDays(raw: string | null): number {
  const value = Number(raw ?? DEFAULT_DAYS);
  if (!Number.isInteger(value) || value < 1) return DEFAULT_DAYS;
  return Math.min(value, MAX_DAYS);
}

function cleanText(raw: string | null, max: number): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'all') return null;
  return trimmed.slice(0, max);
}

/** Adds `alias.created_at >= window start` + district/category conditions. */
function complaintFilters(alias: string, params: unknown[], windowStart: Date, district: string | null, category: string | null): string {
  const conds: string[] = [];
  conds.push(`${alias}.created_at >= $${params.push(windowStart)}`);
  if (district) conds.push(`${alias}.district = $${params.push(district)}`);
  if (category) {
    conds.push(
      `${alias}.category_id = (SELECT id FROM categories WHERE code = $${params.push(category)})`
    );
  }
  return conds.join(' AND ');
}

/** EXISTS clause that scopes a claims/solutions/partnerships row to the
 *  selected complaint scope (used only when district/category are set). */
function complaintScopeExists(
  params: unknown[],
  complaintExpr: string,
  windowStart: Date,
  district: string | null,
  category: string | null
): string {
  if (!district && !category) return '';
  const conds: string[] = [];
  conds.push(`c.created_at >= $${params.push(windowStart)}`);
  if (district) conds.push(`c.district = $${params.push(district)}`);
  if (category) {
    conds.push(`c.category_id = (SELECT id FROM categories WHERE code = $${params.push(category)})`);
  }
  return ` AND EXISTS (SELECT 1 FROM complaints c WHERE ${complaintExpr} AND ${conds.join(' AND ')})`;
}

function toNumber(value: string | number | null): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/* ----------------------------------------------------------------------------
 * Types
 * -------------------------------------------------------------------------- */

interface Metrics {
  generatedAt: string;
  filters: {
    days: number;
    district: string | null;
    category: string | null;
  };
  options: {
    districts: { district: string; complaints: number }[];
    categories: { code: string; name: string }[];
  };
  kpis: Record<string, number | string>;
  statusCounts: Record<string, number>;
  domains: DomainRow[];
  districts: DistrictRow[];
  pendency: { openComplaints: number; buckets: { key: string; label: string; count: number; share: number }[] };
  trend: TrendPoint[];
  funding: { byType: Record<string, { count: number; amount: number }> };
  institutions: InstitutionRow[];
  teamMix: Record<string, number>;
}

interface DomainRow {
  code: string;
  name: string;
  complaints: number;
  resolved: number;
  resolutionRate: number;
  claims: number;
  solutionsApproved: number;
}

interface DistrictRow {
  district: string;
  complaints: number;
  openComplaints: number;
  resolved: number;
  resolutionRate: number;
  avgResolutionDays: number | null;
}

interface InstitutionRow {
  name: string;
  claims: number;
  solutionsApproved: number;
}

interface TrendPoint {
  ym: string;
  label: string;
  newComplaints: number;
  resolved: number;
  pledgedInr: number;
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
    console.error('[GET /api/admin/analytics] DB not configured:', error);
    return NextResponse.json(
      { error: 'Database is not configured. Set DATABASE_URL first.' },
      { status: 500 }
    );
  }

  const searchParams = request.nextUrl.searchParams;
  const days = clampDays(searchParams.get('days'));
  const district = cleanText(searchParams.get('district'), 100);
  const category = cleanText(searchParams.get('category')?.toUpperCase() ?? null, 32);
  const windowStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  try {
    /* ---- authorization ------------------------------------------------------ */
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
        { error: 'Only govt_admin accounts may view the analytics command center.' },
        { status: 403 }
      );
    }

    /* ---- filter options (independent of the district/category selection) ---- */
    const districtOptions = await pool.query<{ district: string; complaints: number }>(
      `SELECT NULLIF(btrim(district), '') AS district, count(*)::int AS complaints
         FROM complaints
        WHERE district IS NOT NULL
          AND btrim(district) <> ''
          AND created_at >= $1
        GROUP BY 1
        ORDER BY complaints DESC, district`,
      [windowStart]
    );
    const categoriesResult = await pool.query<{ code: string; name: string }>(
      `SELECT code, name FROM categories WHERE is_active = TRUE ORDER BY code`
    );

    /* ---- KPI headline row (complaint-centric) -------------------------------- */
    const kpiParams: unknown[] = [];
    const kpiResult = await pool.query<{
      total: number;
      open: number;
      resolved: number;
      duplicates: number;
    }>(
      `SELECT
         count(*)::int                                                     AS total,
         count(*) FILTER (WHERE status <> 'resolved')::int                 AS open,
         count(*) FILTER (WHERE status = 'resolved')::int                  AS resolved,
         count(*) FILTER (WHERE cluster_id IS NOT NULL)::int               AS duplicates
      FROM complaints c
      WHERE ${complaintFilters('c', kpiParams, windowStart, district, category)}`,
      kpiParams
    );
    const kpi = kpiResult.rows[0] ?? { total: 0, open: 0, resolved: 0, duplicates: 0 };

    /* ---- status counts ------------------------------------------------------- */
    const statusParams: unknown[] = [];
    const statusResult = await pool.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n
         FROM complaints c
        WHERE ${complaintFilters('c', statusParams, windowStart, district, category)}
        GROUP BY status`,
      statusParams
    );
    const statusCounts: Record<string, number> = {
      submitted: 0,
      under_review: 0,
      assigned: 0,
      in_progress: 0,
      resolved: 0,
    };
    for (const row of statusResult.rows) statusCounts[row.status] = row.n;

    /* ---- average resolution latency (resolved only) --------------------------- */
    const latencyParams: unknown[] = [];
    const latencyResult = await pool.query<{ avg_days: number | null }>(
      `SELECT COALESCE(
                AVG(EXTRACT(EPOCH FROM (r.resolved_at - c.created_at)) / 86400.0),
                0
              )::float8 AS avg_days
         FROM complaints c
         JOIN LATERAL (
              SELECT MIN(sl.created_at) AS resolved_at
                FROM status_logs sl
               WHERE sl.complaint_id = c.id AND sl.new_status = 'resolved'
         ) r ON r.resolved_at IS NOT NULL
        WHERE c.status = 'resolved'
          AND ${complaintFilters('c', latencyParams, windowStart, district, category)}`,
      latencyParams
    );
    const avgResolutionDays = round1(toNumber(latencyResult.rows[0]?.avg_days ?? null));

    /* ---- claims + adoptions pipeline (window on claims.created_at) ----------- */
    const claimsParams: unknown[] = [];
    claimsParams.push(windowStart);
    const claimsResult = await pool.query<{ total: number; approved: number }>(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE approval_status = 'approved')::int AS approved
      FROM claims cl
      WHERE cl.created_at >= $1${complaintScopeExists(
        claimsParams,
        'c.id = cl.complaint_id',
        windowStart,
        district,
        category
      )}`,
      claimsParams
    );

    /* ---- solutions pipeline (window on submitted_at) ------------------------- */
    const solutionsParams: unknown[] = [];
    solutionsParams.push(windowStart);
    const solutionsResult = await pool.query<{ total: number; approved: number }>(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE status = 'approved')::int AS approved
      FROM solutions s
      WHERE s.submitted_at IS NOT NULL
        AND s.submitted_at >= $1${complaintScopeExists(
          solutionsParams,
          'c.id = (SELECT complaint_id FROM claims WHERE id = s.claim_id)',
          windowStart,
          district,
          category
        )}`,
      solutionsParams
    );

    /* ---- funding headline row (window on pledge date) ------------------------ */
    const fundingParams: unknown[] = [];
    fundingParams.push(windowStart);
    const fundingResult = await pool.query<{
      total: number;
      active: number;
      committed: string | number;
      partners: number;
    }>(
      `SELECT
         count(*)::int                                                       AS total,
         count(*) FILTER (WHERE status IN ('active', 'matched'))::int        AS active,
         COALESCE(sum(amount_inr), 0)                                        AS committed,
         count(DISTINCT partner_user_id)::int                                AS partners
      FROM partnerships p
      WHERE p.status IN ('pending', 'active', 'matched')
        AND p.created_at >= $1${complaintScopeExists(
          fundingParams,
          'c.id = (SELECT complaint_id FROM claims WHERE id = (SELECT claim_id FROM solutions WHERE id = p.solution_id))',
          windowStart,
          district,
          category
        )}`,
      fundingParams
    );
    const funding = fundingResult.rows[0] ?? { total: 0, active: 0, committed: 0, partners: 0 };

    /* ---- funding split by pledge type ---------------------------------------- */
    const byTypeParams: unknown[] = [];
    byTypeParams.push(windowStart);
    const byTypeResult = await pool.query<{ pledge_type: string; n: number; amount: string | number }>(
      `SELECT pledge_type, count(*)::int AS n, COALESCE(sum(amount_inr), 0) AS amount
         FROM partnerships p
        WHERE p.status IN ('pending', 'active', 'matched')
          AND p.created_at >= $1${complaintScopeExists(
            byTypeParams,
            'c.id = (SELECT complaint_id FROM claims WHERE id = (SELECT claim_id FROM solutions WHERE id = p.solution_id))',
            windowStart,
            district,
            category
          )}
        GROUP BY pledge_type`,
      byTypeParams
    );
    const byType: Record<string, { count: number; amount: number }> = {
      grant: { count: 0, amount: 0 },
      mentorship: { count: 0, amount: 0 },
      pilot: { count: 0, amount: 0 },
    };
    for (const row of byTypeResult.rows) {
      if (byType[row.pledge_type]) {
        byType[row.pledge_type].count = row.n;
        byType[row.pledge_type].amount = toNumber(row.amount);
      }
    }

    /* ---- domain-wise distribution + innovation pipeline ---------------------- */
    const domainParams: unknown[] = [];
    domainParams.push(windowStart);
    const onConditions: string[] = ['c.category_id = cat.id', `c.created_at >= $1`];
    if (district) onConditions.push(`c.district = $${domainParams.push(district)}`);
    const domainResult = await pool.query<{
      code: string;
      name: string;
      complaints: number;
      resolved: number;
      claims: number;
      solutions: number;
    }>(
      `SELECT
         cat.code,
         cat.name,
         count(DISTINCT c.id)::int AS complaints,
         count(DISTINCT c.id) FILTER (WHERE c.status = 'resolved')::int AS resolved,
         count(DISTINCT cl.id)::int AS claims,
         count(DISTINCT s.id)::int AS solutions
      FROM categories cat
      LEFT JOIN complaints c ON ${onConditions.join(' AND ')}
      LEFT JOIN claims cl    ON cl.complaint_id = c.id
      LEFT JOIN solutions s  ON s.claim_id = cl.id AND s.status = 'approved'
      ${category ? 'WHERE cat.code = $' + (domainParams.push(category) ) : 'WHERE cat.is_active = TRUE'}
      GROUP BY cat.code, cat.name
      ORDER BY complaints DESC, cat.code`,
      domainParams
    );
    const domains: DomainRow[] = domainResult.rows.map((row) => {
      const rate = row.complaints > 0 ? (row.resolved / row.complaints) * 100 : 0;
      return {
        code: row.code,
        name: row.name,
        complaints: row.complaints,
        resolved: row.resolved,
        resolutionRate: round1(rate),
        claims: row.claims,
        solutionsApproved: row.solutions,
      };
    });

    /* ---- district performance table ------------------------------------------ */
    const districtParams: unknown[] = [];
    districtParams.push(windowStart);
    const districtConds: string[] = [`c.created_at >= $1`];
    if (category) {
      districtConds.push(`c.category_id = (SELECT id FROM categories WHERE code = $${districtParams.push(category)})`);
    }
    if (district) {
      districtConds.push(`c.district = $${districtParams.push(district)}`);
    }
    const districtResult = await pool.query<{
      district: string;
      complaints: number;
      resolved: number;
      avg_days: number | null;
    }>(
      `SELECT
         NULLIF(btrim(c.district), '') AS district,
         count(*)::int AS complaints,
         count(*) FILTER (WHERE c.status = 'resolved')::int AS resolved,
         COALESCE(
           AVG(CASE WHEN r.resolved_at IS NOT NULL
                    THEN EXTRACT(EPOCH FROM (r.resolved_at - c.created_at)) / 86400.0 END),
           0
         )::float8 AS avg_days
      FROM complaints c
      LEFT JOIN LATERAL (
           SELECT MIN(sl.created_at) AS resolved_at
             FROM status_logs sl
            WHERE sl.complaint_id = c.id AND sl.new_status = 'resolved'
      ) r ON TRUE
      WHERE c.district IS NOT NULL
        AND btrim(c.district) <> ''
        AND ${districtConds.join(' AND ')}
      GROUP BY 1
      ORDER BY complaints DESC`,
      districtParams
    );
    const districts: DistrictRow[] = districtResult.rows.map((row) => {
      const resolved = row.resolved;
      return {
        district: row.district,
        complaints: row.complaints,
        openComplaints: row.complaints - resolved,
        resolved,
        resolutionRate: row.complaints > 0 ? round1((resolved / row.complaints) * 100) : 0,
        avgResolutionDays: row.complaints > 0 ? round1(toNumber(row.avg_days)) : null,
      };
    });

    /* ---- pendency age brackets (open complaints only) ------------------------ */
    const pendencyParams: unknown[] = [];
    const pendencyResult = await pool.query<{ b_7: number; b_30: number; b_90: number; b_older: number }>(
      `SELECT
         count(*) FILTER (WHERE c.created_at >= now() - interval '7 days')::int        AS b_7,
         count(*) FILTER (WHERE c.created_at < now() - interval '7 days'
                          AND c.created_at >= now() - interval '30 days')::int         AS b_30,
         count(*) FILTER (WHERE c.created_at < now() - interval '30 days'
                          AND c.created_at >= now() - interval '90 days')::int         AS b_90,
         count(*) FILTER (WHERE c.created_at < now() - interval '90 days')::int        AS b_older
      FROM complaints c
      WHERE c.status <> 'resolved'
        AND ${complaintFilters('c', pendencyParams, windowStart, district, category)}`,
      pendencyParams
    );
    const pendencyRow = pendencyResult.rows[0] ?? { b_7: 0, b_30: 0, b_90: 0, b_older: 0 };
    const openComplaints = kpi.open;
    const bucketSpecs = [
      { key: '0-7', label: '0–7 days', count: pendencyRow.b_7 },
      { key: '8-30', label: '8–30 days', count: pendencyRow.b_30 },
      { key: '31-90', label: '31–90 days', count: pendencyRow.b_90 },
      { key: '90+', label: '90+ days', count: pendencyRow.b_older },
    ];
    const pendency = {
      openComplaints,
      buckets: bucketSpecs.map((b) => ({
        key: b.key,
        label: b.label,
        count: b.count,
        share: openComplaints > 0 ? round1((b.count / openComplaints) * 100) : 0,
      })),
    };

    /* ---- monthly trend (complaints created / resolved / ₹ pledged) ------------ */
    const trendParams: unknown[] = [];
    const trendComplaints = await pool.query<{ ym: string; n: number }>(
      `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS ym, count(*)::int AS n
         FROM complaints c
        WHERE ${complaintFilters('c', trendParams, windowStart, district, category)}
        GROUP BY 1`,
      trendParams
    );
    const trendResolvedParams: unknown[] = [];
    const trendResolved = await pool.query<{ ym: string; n: number }>(
      `SELECT to_char(date_trunc('month', sl.created_at), 'YYYY-MM') AS ym,
              count(DISTINCT c.id)::int AS n
         FROM complaints c
         JOIN status_logs sl ON sl.complaint_id = c.id AND sl.new_status = 'resolved'
        WHERE ${complaintFilters('c', trendResolvedParams, windowStart, district, category)}
        GROUP BY 1`,
      trendResolvedParams
    );
    const trendPledgeParams: unknown[] = [];
    trendPledgeParams.push(windowStart);
    const trendPledges = await pool.query<{ ym: string; n: number; amount: string | number }>(
      `SELECT to_char(date_trunc('month', p.created_at), 'YYYY-MM') AS ym,
              count(*)::int AS n,
              COALESCE(sum(p.amount_inr), 0) AS amount
         FROM partnerships p
        WHERE p.status IN ('pending', 'active', 'matched')
          AND p.created_at >= $1${complaintScopeExists(
            trendPledgeParams,
            'c.id = (SELECT complaint_id FROM claims WHERE id = (SELECT claim_id FROM solutions WHERE id = p.solution_id))',
            windowStart,
            district,
            category
          )}
        GROUP BY 1`,
      trendPledgeParams
    );

    const complaintMap = new Map(trendComplaints.rows.map((r) => [r.ym, r.n]));
    const resolvedMap = new Map(trendResolved.rows.map((r) => [r.ym, r.n]));
    const pledgeMap = new Map(
      trendPledges.rows.map((r) => [r.ym, { n: r.n, amount: toNumber(r.amount) }])
    );
    const months = [
      ...new Set([
        ...complaintMap.keys(),
        ...resolvedMap.keys(),
        ...pledgeMap.keys(),
      ]),
    ].sort();
    const trend: TrendPoint[] = months.map((ym) => {
      const [year, month] = ym.split('-').map(Number);
      const label = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-IN', {
        month: 'short',
        year: '2-digit',
      });
      return {
        ym,
        label,
        newComplaints: complaintMap.get(ym) ?? 0,
        resolved: resolvedMap.get(ym) ?? 0,
        pledgedInr: pledgeMap.get(ym)?.amount ?? 0,
      };
    });

    /* ---- institutional (HEI/NGO) participation ------------------------------- */
    const institutionParams: unknown[] = [];
    institutionParams.push(windowStart);
    const institutionsResult = await pool.query<{
      name: string;
      claims: number;
      solutions: number;
    }>(
      `SELECT
         NULLIF(btrim(cl.institution_name), '') AS name,
         count(*)::int AS claims,
         count(DISTINCT s.id)::int AS solutions
      FROM claims cl
      LEFT JOIN solutions s ON s.claim_id = cl.id AND s.status = 'approved'
      WHERE cl.institution_name IS NOT NULL
        AND btrim(cl.institution_name) <> ''
        AND cl.created_at >= $1${complaintScopeExists(
          institutionParams,
          'c.id = cl.complaint_id',
          windowStart,
          district,
          category
        )}
      GROUP BY 1
      ORDER BY claims DESC, name
      LIMIT 8`,
      institutionParams
    );
    const institutions: InstitutionRow[] = institutionsResult.rows.map((row) => ({
      name: row.name,
      claims: row.claims,
      solutionsApproved: row.solutions,
    }));

    const institutionsTotalParams: unknown[] = [];
    institutionsTotalParams.push(windowStart);
    const institutionsTotal = await pool.query<{ n: number }>(
      `SELECT count(DISTINCT NULLIF(btrim(cl.institution_name), ''))::int AS n
         FROM claims cl
        WHERE cl.institution_name IS NOT NULL
          AND btrim(cl.institution_name) <> ''
          AND cl.created_at >= $1${complaintScopeExists(
            institutionsTotalParams,
            'c.id = cl.complaint_id',
            windowStart,
            district,
            category
          )}`,
      institutionsTotalParams
    );

    /* ---- team mix (student / NGO / institution adoptions) -------------------- */
    const teamMixParams: unknown[] = [];
    teamMixParams.push(windowStart);
    const teamMixResult = await pool.query<{ team_type: string; n: number }>(
      `SELECT team_type, count(*)::int AS n
         FROM claims cl
        WHERE cl.created_at >= $1${complaintScopeExists(
          teamMixParams,
          'c.id = cl.complaint_id',
          windowStart,
          district,
          category
        )}
        GROUP BY team_type`,
      teamMixParams
    );
    const teamMix: Record<string, number> = { student: 0, ngo: 0, institution: 0 };
    for (const row of teamMixResult.rows) if (teamMix[row.team_type] !== undefined) teamMix[row.team_type] = row.n;

    /* ---- assemble response --------------------------------------------------- */
    const total = kpi.total;
    const claimsTotal = claimsResult.rows[0]?.total ?? 0;
    const claimsApproved = claimsResult.rows[0]?.approved ?? 0;
    const solutionsTotal = solutionsResult.rows[0]?.total ?? 0;
    const solutionsApproved = solutionsResult.rows[0]?.approved ?? 0;
    const committedInr = toNumber(funding.committed);
    const claimsApprovalRate = claimsTotal > 0 ? round1((claimsApproved / claimsTotal) * 100) : 0;

    const metrics: Metrics = {
      generatedAt: new Date().toISOString(),
      filters: { days, district, category },
      options: {
        districts: districtOptions.rows.map((r) => ({ district: r.district, complaints: r.complaints })),
        categories: categoriesResult.rows.map((r) => ({ code: r.code, name: r.name })),
      },
      kpis: {
        totalComplaints: total,
        openComplaints: kpi.open,
        resolvedComplaints: kpi.resolved,
        resolutionRate: total > 0 ? round1((kpi.resolved / total) * 100) : 0,
        avgResolutionDays,
        duplicateReports: kpi.duplicates,
        duplicateRate: total > 0 ? round1((kpi.duplicates / total) * 100) : 0,
        claimsTotal,
        claimsApproved,
        claimsApprovalRate,
        solutionsTotal,
        solutionsApproved,
        pledgesTotal: funding.total,
        pledgesActive: funding.active,
        committedInr,
        pledgingPartners: funding.partners,
        institutionsTotal: institutionsTotal.rows[0]?.n ?? 0,
      },
      statusCounts,
      domains,
      districts,
      pendency,
      trend,
      funding: { byType },
      institutions,
      teamMix,
    };

    return NextResponse.json(metrics);
  } catch (error) {
    console.error('[GET /api/admin/analytics] aggregation failed:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to aggregate analytics: ${error.message}`
            : 'Failed to aggregate analytics.',
      },
      { status: 500 }
    );
  }
}
