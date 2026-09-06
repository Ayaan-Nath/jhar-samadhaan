'use client';

/* ============================================================================
 * State Administrator Analytics & Impact Dashboard — Module 8
 * (app/admin/analytics/page.tsx)
 *
 * Executive dashboard for Jharkhand state admins: macro KPIs, domain-wise
 * distribution with the innovation pipeline, district performance, pendency
 * age brackets, institutional (HEI) participation, industry funding pledges
 * and monthly submission/resolution trends. Pure CSS/SVG charts — no chart
 * library dependency.
 *
 * Data comes from /api/admin/analytics:
 *   GET /api/admin/analytics?days=365&district=Ranchi&category=WAT
 *       (header x-admin-id) -> AnalyticsMetrics
 *
 * DEMO AUTH: pass a govt_admin user id as ?admin=NNN (mirrors the x-admin-id
 * header auth used across the stack until sessions exist).
 * ==========================================================================*/

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useSearchParams } from 'next/navigation';

/* ----------------------------------------------------------------------------
 * Types (mirror /api/admin/analytics)
 * -------------------------------------------------------------------------- */

export interface DomainRow {
  code: string;
  name: string;
  complaints: number;
  resolved: number;
  resolutionRate: number;
  claims: number;
  solutionsApproved: number;
}

export interface DistrictRow {
  district: string;
  complaints: number;
  openComplaints: number;
  resolved: number;
  resolutionRate: number;
  avgResolutionDays: number | null;
}

export interface AnalyticsMetrics {
  generatedAt: string;
  filters: { days: number; district: string | null; category: string | null };
  options: {
    districts: { district: string; complaints: number }[];
    categories: { code: string; name: string }[];
  };
  kpis: {
    totalComplaints: number;
    openComplaints: number;
    resolvedComplaints: number;
    resolutionRate: number;
    avgResolutionDays: number;
    duplicateReports: number;
    duplicateRate: number;
    claimsTotal: number;
    claimsApproved: number;
    claimsApprovalRate: number;
    solutionsTotal: number;
    solutionsApproved: number;
    pledgesTotal: number;
    pledgesActive: number;
    committedInr: number;
    pledgingPartners: number;
    institutionsTotal: number;
  };
  statusCounts: Record<string, number>;
  domains: DomainRow[];
  districts: DistrictRow[];
  pendency: {
    openComplaints: number;
    buckets: { key: string; label: string; count: number; share: number }[];
  };
  trend: { ym: string; label: string; newComplaints: number; resolved: number; pledgedInr: number }[];
  funding: { byType: Record<string, { count: number; amount: number }> };
  institutions: { name: string; claims: number; solutionsApproved: number }[];
  teamMix: Record<string, number>;
}

const API_ENDPOINT = '/api/admin/analytics';
const REQUEST_TIMEOUT_MS = 20_000;

const DAY_OPTIONS = [
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
  { value: 180, label: 'Last 6 months' },
  { value: 365, label: 'Last 12 months' },
  { value: 3650, label: 'All time' },
];

const STATUS_ORDER = ['submitted', 'under_review', 'assigned', 'in_progress', 'resolved'];

const STATUS_META: Record<string, { label: string; classes: string; bar: string }> = {
  submitted: { label: 'Submitted', classes: 'bg-sky-100 text-sky-800', bar: 'bg-sky-500' },
  under_review: { label: 'Under review', classes: 'bg-amber-100 text-amber-800', bar: 'bg-amber-500' },
  assigned: { label: 'Assigned', classes: 'bg-violet-100 text-violet-800', bar: 'bg-violet-500' },
  in_progress: { label: 'In progress', classes: 'bg-indigo-100 text-indigo-800', bar: 'bg-indigo-500' },
  resolved: { label: 'Resolved', classes: 'bg-emerald-100 text-emerald-800', bar: 'bg-emerald-500' },
};

const DOMAIN_DOT: Record<string, string> = {
  AGR: 'bg-lime-500',
  WAT: 'bg-sky-500',
  HLT: 'bg-rose-500',
  EDU: 'bg-amber-500',
  PWR: 'bg-yellow-500',
  INF: 'bg-indigo-500',
  SWM: 'bg-teal-500',
  OTH: 'bg-slate-400',
};

const PLEDGE_TYPE_META: Record<string, { label: string; icon: string; tile: string }> = {
  grant: { label: 'Financial grants', icon: '💰', tile: 'from-emerald-50 to-teal-50 ring-emerald-200' },
  mentorship: { label: 'Mentorship', icon: '🧭', tile: 'from-sky-50 to-indigo-50 ring-sky-200' },
  pilot: { label: 'Pilot deployments', icon: '🚀', tile: 'from-amber-50 to-orange-50 ring-amber-200' },
};

function fmtInr(value: number): string {
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `₹${value.toLocaleString('en-IN')}`;
  }
}

function fmtNum(value: number): string {
  return value.toLocaleString('en-IN');
}

function fmtDays(value: number): string {
  if (value <= 0) return '—';
  if (value < 1) return `${Math.round(value * 24)}h`;
  return `${Math.round(value)}d`;
}

/* ----------------------------------------------------------------------------
 * Small visual building blocks (pure CSS — no chart dependency)
 * -------------------------------------------------------------------------- */

function SectionCard({
  title,
  subtitle,
  right,
  children,
  className = '',
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-slate-900">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
        </div>
        {right}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Horizontal stacked bar: open (slate) vs resolved (emerald). */
function StackedBar({ open, resolved }: { open: number; resolved: number }) {
  const total = open + resolved;
  if (total === 0) {
    return <div className="h-2.5 w-full rounded-full bg-slate-100" />;
  }
  const openPct = (open / total) * 100;
  return (
    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
      {resolved > 0 && (
        <div
          className="h-full bg-emerald-500"
          style={{ width: `${100 - openPct}%` }}
          title={`${resolved} resolved`}
        />
      )}
      {open > 0 && (
        <div
          className="h-full bg-slate-300"
          style={{ width: `${openPct}%` }}
          title={`${open} open`}
        />
      )}
    </div>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-center text-xs text-slate-400">
      {children}
    </p>
  );
}

/* ----------------------------------------------------------------------------
 * CSV export helpers
 * -------------------------------------------------------------------------- */

function downloadCsv(filename: string, header: string[], rows: (string | number)[][]) {
  const escape = (cell: string | number) => {
    const text = String(cell);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const content = [header, ...rows].map((row) => row.map(escape).join(',')).join('\n');
  const blob = new Blob(['\uFEFF', content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/* ----------------------------------------------------------------------------
 * Dashboard
 * -------------------------------------------------------------------------- */

function AnalyticsCommandCenter() {
  const searchParams = useSearchParams();
  const adminUserId = searchParams.get('admin') ?? '';

  const [days, setDays] = useState(365);
  const [district, setDistrict] = useState<string>('all');
  const [category, setCategory] = useState<string>('all');

  const [metrics, setMetrics] = useState<AnalyticsMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const fetchAnalytics = useCallback(async () => {
    if (!adminUserId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    const query = new URLSearchParams({ days: String(days) });
    if (district !== 'all') query.set('district', district);
    if (category !== 'all') query.set('category', category);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_ENDPOINT}?${query.toString()}`, {
        headers: { 'x-admin-id': adminUserId },
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(
          data?.error ??
            (response.status === 401
              ? 'Authentication failed — pass a valid ?admin= govt_admin id.'
              : `The server returned HTTP ${response.status}.`)
        );
      }
      const data = (await response.json()) as AnalyticsMetrics;
      setMetrics(data);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : 'Failed to load analytics.'
      );
    } finally {
      setLoading(false);
    }
  }, [adminUserId, days, district, category]);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  /* ---- memoised helpers ------------------------------------------------------ */
  const maxDomainComplaints = useMemo(
    () => Math.max(1, ...(metrics?.domains.map((d) => d.complaints) ?? [0])),
    [metrics]
  );
  const trendMax = useMemo(() => {
    const values = metrics?.trend.flatMap((t) => [t.newComplaints, t.resolved]) ?? [0];
    return Math.max(1, ...values);
  }, [metrics]);
  const maxTrendPledge = useMemo(() => {
    const values = metrics?.trend.map((t) => t.pledgedInr) ?? [0];
    return Math.max(1, ...values);
  }, [metrics]);

  const exportDomains = () => {
    if (!metrics) return;
    downloadCsv(
      `domains-${days}d.csv`,
      ['Category', 'Name', 'Complaints', 'Resolved', 'ResolutionRate%', 'Claims', 'ApprovedSolutions'],
      metrics.domains.map((d) => [
        d.code,
        d.name,
        d.complaints,
        d.resolved,
        d.resolutionRate,
        d.claims,
        d.solutionsApproved,
      ])
    );
    setFeedback({ tone: 'ok', text: 'Domains CSV exported.' });
  };

  const exportDistricts = () => {
    if (!metrics) return;
    downloadCsv(
      `districts-${days}d.csv`,
      ['District', 'Complaints', 'Open', 'Resolved', 'ResolutionRate%', 'AvgResolutionDays'],
      metrics.districts.map((d) => [
        d.district,
        d.complaints,
        d.openComplaints,
        d.resolved,
        d.resolutionRate,
        d.avgResolutionDays ?? '',
      ])
    );
    setFeedback({ tone: 'ok', text: 'Districts CSV exported.' });
  };

  const clearFilters = () => {
    setDistrict('all');
    setCategory('all');
  };

  const kpi = metrics?.kpis;

  return (
    <div className="min-h-screen bg-slate-100">
      <main className="mx-auto w-full max-w-7xl px-4 py-8">
        {/* ---------- header ---------- */}
        <header className="text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-indigo-700">
            Module 8 · Governance Analytics &amp; Impact
          </p>
          <h1 className="mt-1 text-2xl font-bold text-slate-900 sm:text-3xl">
            Jharkhand SIH Analytics Command Center
          </h1>
          <p className="mx-auto mt-2 max-w-2xl text-sm text-slate-500">
            Macro-level social outcomes and innovation metrics across districts
            and thematic domains — crowd-to-resolution, academic adoption,
            industry funding and loop closure.
          </p>
        </header>

        {/* ---------- demo auth gate ---------- */}
        {!adminUserId ? (
          <div className="mx-auto mt-10 max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
            <p className="text-3xl">🏛️</p>
            <h2 className="mt-2 text-sm font-bold text-slate-700">
              Demo authentication required
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Open the command center as a government administrator:
            </p>
            <code className="mt-3 inline-block rounded-lg bg-slate-100 px-3 py-1.5 font-mono text-xs text-indigo-700">
              /admin/analytics?admin=1
            </code>
          </div>
        ) : loading && !metrics ? (
          <div className="mt-8 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 8 }).map((_, index) => (
                <div
                  key={index}
                  className="h-24 animate-pulse rounded-2xl border border-slate-200 bg-slate-200/70"
                />
              ))}
            </div>
            <div className="h-80 animate-pulse rounded-2xl border border-slate-200 bg-slate-200/70" />
          </div>
        ) : loadError && !metrics ? (
          <div className="mx-auto mt-8 max-w-lg rounded-2xl border border-rose-200 bg-rose-50 p-6 text-center">
            <p className="text-3xl">📡</p>
            <h2 className="mt-2 text-sm font-bold text-rose-800">
              Could not load analytics
            </h2>
            <p className="mt-1 text-sm text-rose-700">{loadError}</p>
            <button
              type="button"
              onClick={fetchAnalytics}
              className="mt-4 rounded-full bg-rose-600 px-5 py-2 text-sm font-semibold text-white hover:bg-rose-700"
            >
              Retry
            </button>
          </div>
        ) : !metrics ? (
          <div className="mx-auto mt-8 max-w-lg rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
            <p className="text-4xl">📊</p>
            <h2 className="mt-2 text-sm font-bold text-slate-700">No analytics yet</h2>
            <p className="mt-1 text-sm text-slate-500">{loadError ?? 'Nothing to show.'}</p>
          </div>
        ) : (
          <>
            {/* ---------- filter bar + export ---------- */}
            <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <label htmlFor="days-filter" className="block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      Time bucket
                    </label>
                    <select
                      id="days-filter"
                      value={days}
                      onChange={(e) => setDays(Number(e.target.value))}
                      className="mt-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                    >
                      {DAY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="district-filter" className="block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      District
                    </label>
                    <select
                      id="district-filter"
                      value={district}
                      onChange={(e) => setDistrict(e.target.value)}
                      className="mt-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                    >
                      <option value="all">All districts</option>
                      {metrics.options.districts.map((option) => (
                        <option key={option.district} value={option.district}>
                          {option.district} ({fmtNum(option.complaints)})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="category-filter" className="block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      Domain
                    </label>
                    <select
                      id="category-filter"
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                      className="mt-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                    >
                      <option value="all">All domains</option>
                      {metrics.options.categories.map((option) => (
                        <option key={option.code} value={option.code}>
                          {option.code} · {option.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  {(district !== 'all' || category !== 'all') && (
                    <button
                      type="button"
                      onClick={clearFilters}
                      className="mt-5 rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    >
                      Clear filters
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={exportDomains}
                    className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 shadow-sm transition hover:bg-slate-50"
                  >
                    ⬇ Domains CSV
                  </button>
                  <button
                    type="button"
                    onClick={exportDistricts}
                    className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 shadow-sm transition hover:bg-slate-50"
                  >
                    ⬇ Districts CSV
                  </button>
                  {loading && (
                    <span className="text-xs text-slate-400">Refreshing…</span>
                  )}
                </div>
              </div>
            </section>

            {/* ---------- KPI cards ---------- */}
            {kpi && (
              <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    📥 Challenge submissions
                  </p>
                  <p className="mt-1 text-2xl font-bold text-slate-900">
                    {fmtNum(kpi.totalComplaints)}
                  </p>
                  <p className="text-[11px] text-slate-400">
                    {fmtNum(kpi.openComplaints)} open · {fmtNum(kpi.resolvedComplaints)} resolved
                  </p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    ✅ Resolution rate
                  </p>
                  <p className="mt-1 text-2xl font-bold text-emerald-600">
                    {kpi.resolutionRate}%
                  </p>
                  <p className="text-[11px] text-slate-400">
                    avg {fmtDays(kpi.avgResolutionDays)} to close
                  </p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    🔁 Duplicates auto-clustered
                  </p>
                  <p className="mt-1 text-2xl font-bold text-slate-900">
                    {fmtNum(kpi.duplicateReports)}
                  </p>
                  <p className="text-[11px] text-slate-400">
                    {kpi.duplicateRate}% of submissions · SBERT triage
                  </p>
                </div>
                <div className="rounded-2xl border border-indigo-100 bg-indigo-50/60 p-4 shadow-sm">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-500">
                    🤝 Industry committed
                  </p>
                  <p className="mt-1 text-2xl font-bold text-indigo-900">
                    {fmtInr(kpi.committedInr)}
                  </p>
                  <p className="text-[11px] text-indigo-500/80">
                    {kpi.pledgesTotal} pledges · {kpi.pledgingPartners} partners
                  </p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    🎓 HEI participation
                  </p>
                  <p className="mt-1 text-2xl font-bold text-slate-900">
                    {fmtNum(kpi.institutionsTotal)}
                  </p>
                  <p className="text-[11px] text-slate-400">institutions &amp; NGOs adopting problems</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    🗂 Claims approved
                  </p>
                  <p className="mt-1 text-2xl font-bold text-slate-900">
                    {fmtNum(kpi.claimsApproved)}
                  </p>
                  <p className="text-[11px] text-slate-400">
                    of {fmtNum(kpi.claimsTotal)} adoptions · {kpi.claimsApprovalRate}% accepted
                  </p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    🧪 Prototypes verified
                  </p>
                  <p className="mt-1 text-2xl font-bold text-slate-900">
                    {fmtNum(kpi.solutionsApproved)}
                  </p>
                  <p className="text-[11px] text-slate-400">
                    of {fmtNum(kpi.solutionsTotal)} iterations approved
                  </p>
                </div>
                <div className="rounded-2xl border border-emerald-100 bg-emerald-50/60 p-4 shadow-sm">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-600">
                    🚦 Active funding
                  </p>
                  <p className="mt-1 text-2xl font-bold text-emerald-900">
                    {fmtNum(kpi.pledgesActive)}
                  </p>
                  <p className="text-[11px] text-emerald-700/80">
                    of {fmtNum(kpi.pledgesTotal)} pledges matched / active
                  </p>
                </div>
              </section>
            )}

            {/* ---------- row 1: domain distribution + workflow funnel ---------- */}
            <div className="mt-6 grid gap-4 lg:grid-cols-3">
              <SectionCard
                title="Domain-wise distribution"
                subtitle={`Complaints by thematic domain in scope (resolved share in green)`}
                className="lg:col-span-2"
                right={
                  <div className="flex items-center gap-3 text-[11px] text-slate-400">
                    <span className="flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full bg-emerald-500" /> Resolved
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full bg-slate-300" /> Open
                    </span>
                  </div>
                }
              >
                {metrics.domains.length === 0 ? (
                  <EmptyNote>No complaints in the selected scope.</EmptyNote>
                ) : (
                  <div className="space-y-3">
                    {metrics.domains.map((domain) => {
                      const open = domain.complaints - domain.resolved;
                      const width = (domain.complaints / maxDomainComplaints) * 100;
                      return (
                        <div key={domain.code}>
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="flex min-w-0 items-center gap-2 font-semibold text-slate-700">
                              <span
                                className={`h-2 w-2 shrink-0 rounded-full ${
                                  DOMAIN_DOT[domain.code] ?? 'bg-slate-400'
                                }`}
                              />
                              <span className="truncate">
                                {domain.code} · {domain.name}
                              </span>
                            </span>
                            <span className="shrink-0 font-mono text-slate-500">
                              {fmtNum(domain.resolved)}/{fmtNum(domain.complaints)} ·{' '}
                              <span className="font-semibold text-emerald-600">
                                {domain.resolutionRate}%
                              </span>
                            </span>
                          </div>
                          <div className="mt-1.5 flex items-center gap-2">
                            <div style={{ width: `${Math.max(width, 6)}%` }}>
                              <StackedBar open={open} resolved={domain.resolved} />
                            </div>
                            <span className="shrink-0 text-[10px] font-medium text-slate-400">
                              🗂{domain.claims} 🧪{domain.solutionsApproved}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </SectionCard>

              <SectionCard
                title="Workflow funnel"
                subtitle="Current status of complaints in scope"
              >
                <div className="space-y-2.5">
                  {STATUS_ORDER.map((status) => {
                    const count = metrics.statusCounts[status] ?? 0;
                    const meta = STATUS_META[status];
                    const pct =
                      kpi && kpi.totalComplaints > 0
                        ? (count / kpi.totalComplaints) * 100
                        : 0;
                    return (
                      <div key={status}>
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium text-slate-600">{meta.label}</span>
                          <span className="font-mono font-semibold text-slate-700">
                            {fmtNum(count)}
                          </span>
                        </div>
                        <div className="mt-1 h-2 w-full rounded-full bg-slate-100">
                          <div
                            className={`h-full rounded-full ${meta.bar}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4 rounded-xl bg-slate-50 p-3 text-xs text-slate-500">
                  <p>
                    <span className="font-semibold text-slate-700">Innovation pipeline:</span>{' '}
                    {fmtNum(kpi?.claimsApproved ?? 0)} approved adoptions →{' '}
                    {fmtNum(kpi?.solutionsApproved ?? 0)} verified prototypes →{' '}
                    {fmtNum(kpi?.resolvedComplaints ?? 0)} complaints closed via the loop.
                  </p>
                </div>
              </SectionCard>
            </div>

            {/* ---------- row 2: funding + institutional participation ---------- */}
            <div className="mt-6 grid gap-4 lg:grid-cols-3">
              <SectionCard
                title="Industry funding & mentorship pledges"
                subtitle={`Financial commitment split by pledge type · ${DAY_OPTIONS.find((o) => o.value === days)?.label.toLowerCase()}`}
                className="lg:col-span-2"
                right={
                  <p className="rounded-full bg-indigo-50 px-3 py-1 text-[11px] font-bold text-indigo-700">
                    {fmtInr(kpi?.committedInr ?? 0)} committed
                  </p>
                }
              >
                {metrics.funding.byType.grant.count === 0 &&
                metrics.funding.byType.mentorship.count === 0 &&
                metrics.funding.byType.pilot.count === 0 ? (
                  <EmptyNote>
                    No partnership pledges in this scope yet — the industry marketplace
                    (Module 5) feeds this panel.
                  </EmptyNote>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-3">
                    {Object.keys(PLEDGE_TYPE_META).map((type) => {
                      const entry = metrics.funding.byType[type] ?? { count: 0, amount: 0 };
                      const meta = PLEDGE_TYPE_META[type];
                      return (
                        <div
                          key={type}
                          className={`rounded-2xl bg-gradient-to-br p-4 ring-1 ${meta.tile}`}
                        >
                          <p className="text-xs font-semibold text-slate-500">
                            {meta.icon} {meta.label}
                          </p>
                          <p className="mt-1.5 text-lg font-bold text-slate-900">
                            {entry.count > 0 ? fmtInr(entry.amount) : '—'}
                          </p>
                          <p className="text-[11px] text-slate-500">
                            {entry.count} pledge{entry.count === 1 ? '' : 's'}
                            {entry.count > 0
                              ? ` · ${Math.round((entry.count / (kpi?.pledgesTotal ?? 1)) * 100)}% share`
                              : ' · open for partners'}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="mt-4">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    Monthly pledge value in scope
                  </p>
                  {metrics.trend.every((t) => t.pledgedInr === 0) ? (
                    <p className="mt-2 text-xs text-slate-400">
                      No pledge value recorded in the trend window.
                    </p>
                  ) : (
                    <>
                      <div className="mt-2 flex items-end gap-1" style={{ height: 90 }}>
                        {metrics.trend.map((point) => (
                          <div
                            key={point.ym}
                            className="flex h-full min-w-0 flex-1 flex-col items-center justify-end"
                          >
                            <div
                              className="w-full max-w-[22px] rounded-t bg-indigo-500"
                              style={{
                                height: `${Math.max(
                                  point.pledgedInr > 0 ? 4 : 1,
                                  (point.pledgedInr / maxTrendPledge) * 100
                                )}%`,
                              }}
                              title={`${point.label}: ${fmtInr(point.pledgedInr)}`}
                            />
                          </div>
                        ))}
                      </div>
                      <div className="mt-1 flex justify-between text-[10px] text-slate-400">
                        {metrics.trend.map((point) => (
                          <span key={point.ym}>{point.label}</span>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </SectionCard>

              <SectionCard
                title="Institutional participation"
                subtitle="HEIs, colleges & NGOs adopting challenges (top 8)"
              >
                {metrics.institutions.length === 0 ? (
                  <EmptyNote>
                    No institutional adoptions in scope yet — the opportunities board
                    (Module 4) feeds this list.
                  </EmptyNote>
                ) : (
                  <ol className="space-y-2.5">
                    {metrics.institutions.map((institution, index) => (
                      <li key={institution.name} className="flex items-center gap-3">
                        <span className="w-5 shrink-0 text-center font-mono text-xs font-bold text-slate-300">
                          {index + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-semibold text-slate-700">
                            {institution.name}
                          </p>
                          <p className="text-[11px] text-slate-400">
                            {institution.claims} claim{institution.claims === 1 ? '' : 's'} ·{' '}
                            {institution.solutionsApproved} verified prototype
                            {institution.solutionsApproved === 1 ? '' : 's'}
                          </p>
                        </div>
                        <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-bold text-indigo-600">
                          {institution.claims}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {(Object.keys(metrics.teamMix) as (keyof typeof metrics.teamMix)[]).map(
                    (teamType) => {
                      const count = metrics.teamMix[teamType] ?? 0;
                      return (
                        <span
                          key={teamType}
                          className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600"
                        >
                          {teamType === 'student' ? '🎓 Student' : teamType === 'ngo' ? '🤝 NGO' : '🏫 Institution'}{' '}
                          · {fmtNum(count)}
                        </span>
                      );
                    }
                  )}
                </div>
              </SectionCard>
            </div>

            {/* ---------- row 3: district performance + pendency ---------- */}
            <div className="mt-6 grid gap-4 lg:grid-cols-3">
              <SectionCard
                title="District performance"
                subtitle="Click a district to scope the whole dashboard to it"
                className="lg:col-span-2"
              >
                {metrics.districts.length === 0 ? (
                  <EmptyNote>No geo-tagged complaints in the selected scope.</EmptyNote>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[560px] text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-400">
                          <th className="pb-2 pr-3 font-semibold">District</th>
                          <th className="pb-2 pr-3 text-right font-semibold">Complaints</th>
                          <th className="pb-2 pr-3 font-semibold">Resolution</th>
                          <th className="pb-2 pr-3 text-right font-semibold">Avg days</th>
                        </tr>
                      </thead>
                      <tbody>
                        {metrics.districts.map((row) => {
                          const active = district === row.district;
                          return (
                            <tr
                              key={row.district}
                              className={`border-b border-slate-100 last:border-0 ${
                                active ? 'bg-indigo-50/70' : ''
                              }`}
                            >
                              <td className="py-2.5 pr-3">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setDistrict((prev) =>
                                      prev === row.district ? 'all' : row.district
                                    )
                                  }
                                  className={`flex items-center gap-1.5 font-semibold ${
                                    active
                                      ? 'text-indigo-700 underline underline-offset-2'
                                      : 'text-slate-700 hover:text-indigo-600'
                                  }`}
                                >
                                  📍 {row.district}
                                  {active && <span className="text-[10px]">(scoped)</span>}
                                </button>
                                <p className="text-[10px] text-slate-400">
                                  {fmtNum(row.openComplaints)} open
                                </p>
                              </td>
                              <td className="py-2.5 pr-3 text-right font-mono font-semibold text-slate-700">
                                {fmtNum(row.complaints)}
                              </td>
                              <td className="py-2.5 pr-3">
                                <div className="flex items-center gap-2">
                                  <div className="w-24">
                                    <StackedBar
                                      open={row.openComplaints}
                                      resolved={row.resolved}
                                    />
                                  </div>
                                  <span className="font-mono text-slate-500">
                                    {row.resolutionRate}%
                                  </span>
                                </div>
                              </td>
                              <td className="py-2.5 text-right font-mono text-slate-500">
                                {row.avgResolutionDays !== null
                                  ? fmtDays(row.avgResolutionDays)
                                  : '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </SectionCard>

              <SectionCard
                title="Pendency age brackets"
                subtitle={`Open complaints by age (${fmtNum(metrics.pendency.openComplaints)} pending)`}
              >
                {metrics.pendency.openComplaints === 0 ? (
                  <EmptyNote>No open complaints in scope — everything is resolved.</EmptyNote>
                ) : (
                  <div className="space-y-4">
                    {metrics.pendency.buckets.map((bucket) => {
                      const tone =
                        bucket.key === '0-7'
                          ? 'bg-sky-500'
                          : bucket.key === '8-30'
                            ? 'bg-amber-500'
                            : bucket.key === '31-90'
                              ? 'bg-orange-500'
                              : 'bg-rose-500';
                      const textTone =
                        bucket.key === '90+'
                          ? 'text-rose-600'
                          : bucket.key === '31-90'
                            ? 'text-orange-600'
                            : 'text-slate-600';
                      return (
                        <div key={bucket.key}>
                          <div className="flex items-center justify-between text-xs">
                            <span className={`font-semibold ${textTone}`}>{bucket.label}</span>
                            <span className="font-mono font-semibold text-slate-700">
                              {fmtNum(bucket.count)}{' '}
                              <span className="font-normal text-slate-400">
                                · {bucket.share}%
                              </span>
                            </span>
                          </div>
                          <div className="mt-1 h-2.5 w-full rounded-full bg-slate-100">
                            <div
                              className={`h-full rounded-full ${tone}`}
                              style={{ width: `${bucket.share}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                    <p className="rounded-xl bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
                      {metrics.pendency.buckets[3]?.count ?? 0} complaint
                      {metrics.pendency.buckets[3]?.count === 1 ? '' : 's'} pending over 90 days —
                      flag for district commissioner escalation.
                    </p>
                  </div>
                )}
              </SectionCard>
            </div>

            {/* ---------- row 4: monthly trend ---------- */}
            <div className="mt-6">
              <SectionCard
                title="Monthly submission & resolution trend"
                subtitle="New complaints vs complaints resolved, by calendar month in scope"
                right={
                  <div className="flex items-center gap-3 text-[11px] text-slate-400">
                    <span className="flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full bg-indigo-500" /> New complaints
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full bg-emerald-500" /> Resolved
                    </span>
                  </div>
                }
              >
                {metrics.trend.length === 0 ? (
                  <EmptyNote>No activity in the trend window.</EmptyNote>
                ) : (
                  <>
                    <div className="flex items-end gap-1" style={{ height: 180 }}>
                      {metrics.trend.map((point) => (
                        <div
                          key={point.ym}
                          className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-0.5"
                        >
                          <div className="flex w-full max-w-[38px] items-end justify-center gap-1">
                            <div
                              className="w-1/2 rounded-t bg-indigo-500"
                              style={{
                                height: `${Math.max(
                                  point.newComplaints > 0 ? 4 : 1,
                                  (point.newComplaints / trendMax) * 100
                                )}%`,
                              }}
                              title={`${point.label}: ${point.newComplaints} new`}
                            />
                            <div
                              className="w-1/2 rounded-t bg-emerald-500"
                              style={{
                                height: `${Math.max(
                                  point.resolved > 0 ? 4 : 1,
                                  (point.resolved / trendMax) * 100
                                )}%`,
                              }}
                              title={`${point.label}: ${point.resolved} resolved`}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex justify-between gap-1 text-[10px] text-slate-400">
                      {metrics.trend.map((point) => (
                        <span key={point.ym} className="min-w-0 flex-1 text-center">
                          {point.label}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </SectionCard>
            </div>

            {/* ---------- feedback toast ---------- */}
            {feedback && (
              <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2">
                <button
                  type="button"
                  onClick={() => setFeedback(null)}
                  className={`rounded-full px-4 py-2 text-xs font-semibold text-white shadow-lg ${
                    feedback.tone === 'ok' ? 'bg-slate-900' : 'bg-rose-600'
                  }`}
                >
                  {feedback.text} · dismiss
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Page — Suspense wrapper so useSearchParams can be used safely in Next.js
 * -------------------------------------------------------------------------- */

export default function AdminAnalyticsPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen animate-pulse bg-slate-100" aria-busy="true" />
      }
    >
      <AnalyticsCommandCenter />
    </Suspense>
  );
}
