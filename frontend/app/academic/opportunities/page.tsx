'use client';

/* ============================================================================
 * Academic Opportunities Board — Module 4 (NEP 2020 problem-based learning)
 * (app/academic/opportunities/page.tsx)
 *
 * Lets university faculty and student teams browse validated, active civic
 * problems (cluster heads in 'under_review', not yet adopted) and submit a
 * formal adoption proposal. Data + ingestion come from /api/claims:
 *
 *   GET  /api/claims  -> { opportunities }   (marketplace cards)
 *   POST /api/claims  -> 201 { claim }        (creates a 'pending' claim)
 *
 * Each 'Adopt this Problem' opens the claim modal: Team Name, Institution
 * Name, Team Lead User ID and a proposal (>= 20 chars, NEP 2020 approach).
 * ==========================================================================*/

import { useCallback, useEffect, useState } from 'react';

/* ----------------------------------------------------------------------------
 * Types (mirror /api/claims)
 * -------------------------------------------------------------------------- */

export interface OpportunityCategory {
  code: string;
  label: string;
}

export interface Opportunity {
  id: number;
  title: string;
  description: string;
  category: OpportunityCategory;
  district: string | null;
  location: { latitude: number; longitude: number } | null;
  clusterMembers: number;
  createdAt: string;
}

interface ClaimResponse {
  claim?: {
    id: number;
    complaintId: number;
    approvalStatus: string;
    createdAt: string;
  };
  error?: string;
  message?: string;
}

/* ----------------------------------------------------------------------------
 * Constants
 * -------------------------------------------------------------------------- */

const FILTER_CATEGORIES: OpportunityCategory[] = [
  { code: 'AGR', label: 'Agriculture' },
  { code: 'WAT', label: 'Water & Sanitation' },
  { code: 'HLT', label: 'Health' },
  { code: 'EDU', label: 'Education' },
  { code: 'PWR', label: 'Energy' },
  { code: 'INF', label: 'Infrastructure' },
  { code: 'SWM', label: 'Waste' },
];

const CATEGORY_ACCENTS: Record<string, string> = {
  AGR: 'bg-lime-100 text-lime-800 ring-lime-200',
  WAT: 'bg-sky-100 text-sky-800 ring-sky-200',
  HLT: 'bg-rose-100 text-rose-800 ring-rose-200',
  EDU: 'bg-indigo-100 text-indigo-800 ring-indigo-200',
  PWR: 'bg-amber-100 text-amber-800 ring-amber-200',
  INF: 'bg-slate-200 text-slate-700 ring-slate-300',
  SWM: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
};

const API_ENDPOINT = '/api/claims';
const MIN_PROPOSAL = 20;
const REQUEST_TIMEOUT_MS = 15_000;

/* ----------------------------------------------------------------------------
 * Small helpers
 * -------------------------------------------------------------------------- */

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/* ----------------------------------------------------------------------------
 * Claim modal
 * -------------------------------------------------------------------------- */

type FormErrors = Partial<Record<'teamName' | 'institutionName' | 'teamLeadUserId' | 'proposal', string>>;

interface ClaimModalProps {
  opportunity: Opportunity; // only rendered while open (parent unmounts it)
  onClose: () => void;
  onSubmitted: (complaintId: number) => void; // lets the board refresh
}

function ClaimModal({ opportunity, onClose, onSubmitted }: ClaimModalProps) {
  const [teamName, setTeamName] = useState('');
  const [institutionName, setInstitutionName] = useState('');
  const [teamLeadUserId, setTeamLeadUserId] = useState('');
  const [proposal, setProposal] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [success, setSuccess] = useState<ClaimResponse['claim'] | null>(null);

  const validate = (): FormErrors => {
    const next: FormErrors = {};
    if (teamName.trim().length < 2) {
      next.teamName = 'Please enter your team name.';
    }
    if (institutionName.trim().length < 2) {
      next.institutionName = 'Please enter your institution / university.';
    }
    const leadId = Number(teamLeadUserId.trim());
    if (!Number.isInteger(leadId) || leadId <= 0) {
      next.teamLeadUserId = 'Enter a valid numeric Team Lead User ID.';
    }
    if (proposal.trim().length < MIN_PROPOSAL) {
      next.proposal = `Proposal must be at least ${MIN_PROPOSAL} characters.`;
    }
    return next;
  };

  const handleSubmit = async () => {
    const nextErrors = validate();
    setErrors(nextErrors);
    setServerError(null);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          complaintId: opportunity.id,
          teamName: teamName.trim(),
          institutionName: institutionName.trim(),
          teamLeadUserId: Number(teamLeadUserId.trim()),
          proposal: proposal.trim(),
          teamType: 'student',
        }),
        signal: controller.signal,
      });
      const data = (await response.json().catch(() => null)) as ClaimResponse | null;

      if (!response.ok) {
        setServerError(
          data?.error ??
            `Submission failed (HTTP ${response.status}). Please try again.`
        );
        return;
      }
      if (data?.claim) {
        setSuccess(data.claim);
        onSubmitted(opportunity.id);
      }
    } catch {
      setServerError(
        "We couldn't reach the server — check your connection and try again. Your draft is still here."
      );
    } finally {
      clearTimeout(timer);
      setSubmitting(false);
    }
  };

  const fieldClass = (hasError: boolean) =>
    `w-full rounded-xl border px-3.5 py-2.5 text-sm text-slate-800 outline-none transition focus:ring-2 ${
      hasError
        ? 'border-rose-300 bg-rose-50 focus:border-rose-400 focus:ring-rose-200'
        : 'border-slate-300 bg-white focus:border-emerald-500 focus:ring-emerald-200'
    }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Adopt this problem"
        onClick={(event) => event.stopPropagation()}
        className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl sm:rounded-3xl"
      >
        {success ? (
          /* ---------------- success state ---------------- */
          <div className="py-6 text-center">
            <p className="text-4xl">🎓</p>
            <h2 className="mt-2 text-lg font-bold text-emerald-900">
              Proposal submitted!
            </h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-slate-600">
              Your team has claimed problem #{opportunity.id}. It is now{' '}
              <span className="font-semibold text-amber-700">pending</span>{' '}
              government review in the admin queue.
            </p>
            <div className="mx-auto mt-4 w-fit rounded-xl bg-slate-50 px-4 py-2 text-left text-xs text-slate-500 ring-1 ring-slate-200">
              <p>
                Claim ID <span className="font-semibold text-slate-700">#{success.id}</span>
              </p>
              <p>
                Approval status{' '}
                <span className="font-semibold capitalize text-slate-700">
                  {success.approvalStatus}
                </span>
              </p>
              <p className="mt-0.5">Submitted {formatDate(success.createdAt)}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="mt-5 rounded-full bg-emerald-600 px-6 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-emerald-700"
            >
              Done
            </button>
          </div>
        ) : (
          /* ---------------- form state ---------------- */
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  Adopt this problem
                </h2>
                <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">
                  #{opportunity.id} · {opportunity.title}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <div>
                <label htmlFor="claim-team" className="mb-1 block text-xs font-semibold text-slate-600">
                  Team Name <span className="text-rose-500">*</span>
                </label>
                <input
                  id="claim-team"
                  type="text"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  placeholder="e.g. Team JalSetu, BIT Mesra"
                  className={fieldClass(Boolean(errors.teamName))}
                />
                {errors.teamName && (
                  <p className="mt-1 text-xs font-medium text-rose-600">{errors.teamName}</p>
                )}
              </div>

              <div>
                <label htmlFor="claim-institution" className="mb-1 block text-xs font-semibold text-slate-600">
                  Institution Name <span className="text-rose-500">*</span>
                </label>
                <input
                  id="claim-institution"
                  type="text"
                  value={institutionName}
                  onChange={(e) => setInstitutionName(e.target.value)}
                  placeholder="e.g. Birla Institute of Technology, Mesra"
                  className={fieldClass(Boolean(errors.institutionName))}
                />
                {errors.institutionName && (
                  <p className="mt-1 text-xs font-medium text-rose-600">{errors.institutionName}</p>
                )}
              </div>

              <div>
                <label htmlFor="claim-lead" className="mb-1 block text-xs font-semibold text-slate-600">
                  Team Lead User ID <span className="text-rose-500">*</span>
                </label>
                <input
                  id="claim-lead"
                  type="number"
                  min={1}
                  value={teamLeadUserId}
                  onChange={(e) => setTeamLeadUserId(e.target.value)}
                  placeholder="e.g. 42"
                  className={fieldClass(Boolean(errors.teamLeadUserId))}
                />
                {errors.teamLeadUserId && (
                  <p className="mt-1 text-xs font-medium text-rose-600">{errors.teamLeadUserId}</p>
                )}
              </div>

              <div>
                <div className="mb-1 flex items-baseline justify-between">
                  <label htmlFor="claim-proposal" className="block text-xs font-semibold text-slate-600">
                    Project Proposal (NEP 2020) <span className="text-rose-500">*</span>
                  </label>
                  <span
                    className={`text-[11px] ${
                      proposal.trim().length >= MIN_PROPOSAL
                        ? 'text-emerald-600'
                        : 'text-slate-400'
                    }`}
                  >
                    {proposal.trim().length}/{MIN_PROPOSAL}+ chars
                  </span>
                </div>
                <textarea
                  id="claim-proposal"
                  rows={5}
                  value={proposal}
                  onChange={(e) => setProposal(e.target.value)}
                  placeholder="Describe your planned technical approach — problem framing, proposed solution, target users, and expected community impact…"
                  className={`${fieldClass(Boolean(errors.proposal))} resize-y`}
                />
                {errors.proposal ? (
                  <p className="mt-1 text-xs font-medium text-rose-600">{errors.proposal}</p>
                ) : (
                  <p className="mt-1 text-[11px] text-slate-400">
                    Minimum {MIN_PROPOSAL} characters — evaluated by the Government of Jharkhand
                    moderation desk.
                  </p>
                )}
              </div>
            </div>

            {serverError && (
              <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs font-medium text-rose-700">
                {serverError}
              </div>
            )}

            <div className="mt-5 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="rounded-full border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting}
                className="rounded-full bg-emerald-600 px-6 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? 'Submitting proposal…' : 'Submit for government review →'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Opportunities Board page
 * -------------------------------------------------------------------------- */

export default function AcademicOpportunitiesPage() {
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Opportunity | null>(null);
  const [justAdopted, setJustAdopted] = useState<number | null>(null);

  const fetchOpportunities = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(API_ENDPOINT, {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(
          response.status === 404
            ? 'The claims API (GET /api/claims) is not reachable.'
            : `The server returned HTTP ${response.status}.`
        );
      }
      const data = (await response.json()) as { opportunities?: Opportunity[] };
      setOpportunities(Array.isArray(data.opportunities) ? data.opportunities : []);
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? error.message
          : 'Failed to load opportunities. Check your connection and retry.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOpportunities();
  }, [fetchOpportunities]);

  const visible = opportunities.filter(
    (opportunity) =>
      categoryFilter === 'all' || opportunity.category.code === categoryFilter
  );

  /* Board refresh once a proposal is accepted (card disappears from the grid). */
  const handleClaimSubmitted = (complaintId: number) => {
    setJustAdopted(complaintId);
    fetchOpportunities();
  };

  const renderCard = (opportunity: Opportunity) => {
    const accent = CATEGORY_ACCENTS[opportunity.category.code] ?? 'bg-slate-100 text-slate-600 ring-slate-200';
    const coords = opportunity.location
      ? `${opportunity.location.latitude.toFixed(4)}, ${opportunity.location.longitude.toFixed(4)}`
      : null;

    return (
      <div
        key={opportunity.id}
        className="flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-emerald-300 hover:shadow-md"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${accent}`}>
            {opportunity.category.label}
          </span>
          {opportunity.clusterMembers > 0 && (
            <span
              title="Reports merged into this problem by semantic deduplication"
              className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-semibold text-indigo-800 ring-1 ring-indigo-200"
            >
              👥 {opportunity.clusterMembers} similar report
              {opportunity.clusterMembers > 1 ? 's' : ''}
            </span>
          )}
        </div>

        <h3 className="mt-3 text-sm font-bold leading-snug text-slate-900">
          {opportunity.title}
        </h3>
        <p className="mt-1.5 line-clamp-3 flex-1 text-sm leading-relaxed text-slate-600">
          {opportunity.description}
        </p>

        <div className="mt-3 flex items-center gap-3 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1">
            📍
            <span className="truncate">
              {opportunity.district ?? (coords ? coords : 'Location on map')}
            </span>
          </span>
          <span className="text-slate-300">·</span>
          <span className="text-slate-400">{formatDate(opportunity.createdAt)}</span>
        </div>

        <div className="mt-4 border-t border-slate-100 pt-4">
          <button
            type="button"
            onClick={() => setSelected(opportunity)}
            disabled={justAdopted === opportunity.id}
            className="w-full rounded-full bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 active:scale-[0.99] disabled:opacity-40"
          >
            {justAdopted === opportunity.id
              ? '✓ Claimed — under review'
              : 'Adopt this Problem →'}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-100">
      <main className="mx-auto w-full max-w-6xl px-4 py-8">
        {/* ---------- header ---------- */}
        <header className="text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-emerald-700">
            Module 4 · NEP 2020 Problem-Based Learning
          </p>
          <h1 className="mt-1 text-2xl font-bold text-slate-900 sm:text-3xl">
            Academic Opportunities Board
          </h1>
          <p className="mx-auto mt-2 max-w-xl text-sm text-slate-500">
            Faculty and student teams can adopt validated civic problems from
            Jharkhand and submit formal proposals for government-backed
            prototyping.
          </p>
        </header>

        {/* ---------- category filters ---------- */}
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={() => setCategoryFilter('all')}
            className={`rounded-full px-4 py-1.5 text-xs font-semibold ring-1 transition ${
              categoryFilter === 'all'
                ? 'bg-slate-900 text-white ring-slate-900'
                : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50'
            }`}
          >
            All domains
          </button>
          {FILTER_CATEGORIES.map((category) => (
            <button
              key={category.code}
              type="button"
              onClick={() => setCategoryFilter(category.code)}
              className={`rounded-full px-4 py-1.5 text-xs font-semibold ring-1 transition ${
                categoryFilter === category.code
                  ? 'bg-slate-900 text-white ring-slate-900'
                  : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50'
              }`}
            >
              {category.label}
            </button>
          ))}
        </div>

        {/* ---------- grid ---------- */}
        {loading ? (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <div
                key={index}
                className="h-56 animate-pulse rounded-2xl border border-slate-200 bg-slate-200/70"
              />
            ))}
          </div>
        ) : loadError ? (
          <div className="mt-8 rounded-2xl border border-rose-200 bg-rose-50 p-8 text-center">
            <p className="text-3xl">📡</p>
            <h2 className="mt-2 text-sm font-bold text-rose-800">
              Could not load opportunities
            </h2>
            <p className="mx-auto mt-1 max-w-lg text-sm text-rose-700">{loadError}</p>
            <button
              type="button"
              onClick={fetchOpportunities}
              className="mt-4 rounded-full bg-rose-600 px-5 py-2 text-sm font-semibold text-white hover:bg-rose-700"
            >
              Retry
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
            <p className="text-4xl">🧭</p>
            <h2 className="mt-2 text-sm font-bold text-slate-700">
              No adoptable problems{categoryFilter !== 'all' ? ' in this domain' : ' right now'}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Validated complaints awaiting teams will appear here. Check back
              soon or switch domains.
            </p>
          </div>
        ) : (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map(renderCard)}
          </div>
        )}
      </main>

      {/* ---------- claim modal (mounted only while open) ---------- */}
      {selected && (
        <ClaimModal
          opportunity={selected}
          onClose={() => setSelected(null)}
          onSubmitted={handleClaimSubmitted}
        />
      )}
    </div>
  );
}
