'use client';

/* ============================================================================
 * Admin Prototype Verification & Loop Closure — Module 7
 * (app/admin/solutions/page.tsx)
 *
 * Government reviewers inspect student/NGO prototype iterations (summary,
 * tech stack, repo + live demo links, documentation), then approve, reject,
 * or request revisions with a MANDATORY review comment.
 *
 *   GET  /api/admin/solutions            -> { solutions } (verification queue)
 *   PATCH /api/admin/solutions/:id/review  body { decision, reviewComment }
 *
 * Approving a prototype loops the loop: the complaint advances to 'resolved'
 * (when the workflow legally allows it) and both the team lead and original
 * citizen receive email alerts via the notifications table.
 *
 * DEMO AUTH: pass the govt_admin user id as ?admin=NNN (x-admin-id header).
 * ==========================================================================*/

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';

/* ----------------------------------------------------------------------------
 * Types
 * -------------------------------------------------------------------------- */

type ReviewDecision = 'approved' | 'rejected' | 'revision_requested';
type SolutionStatus =
  | 'draft'
  | 'submitted'
  | 'under_review'
  | 'approved'
  | 'rejected'
  | 'revision_requested';

interface AdminSolution {
  id: number;
  iteration: number;
  title: string;
  summary: string;
  status: SolutionStatus;
  techStack: string[];
  documentation: { label: string | null; url: string }[];
  repositoryUrl: string | null;
  prototypeUrl: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  reviewComment: string | null;
  claim: {
    id: number;
    teamName: string;
    teamType: string;
    institutionName: string | null;
    teamLeadName: string | null;
  };
  complaint: { id: number; title: string; status: string };
}

const LIST_ENDPOINT = '/api/admin/solutions';
const REQUEST_TIMEOUT_MS = 15_000;
const MIN_COMMENT = 10;

const STATUS_ORDER: (SolutionStatus | 'all')[] = [
  'all',
  'submitted',
  'revision_requested',
  'under_review',
  'approved',
  'rejected',
];

const STATUS_META: Record<SolutionStatus, { label: string; badge: string }> = {
  draft: { label: 'Draft', badge: 'bg-slate-100 text-slate-600 ring-slate-200' },
  submitted: { label: 'Submitted', badge: 'bg-sky-100 text-sky-800 ring-sky-200' },
  under_review: { label: 'Under Review', badge: 'bg-amber-100 text-amber-800 ring-amber-200' },
  approved: { label: 'Approved', badge: 'bg-emerald-100 text-emerald-800 ring-emerald-200' },
  rejected: { label: 'Rejected', badge: 'bg-rose-100 text-rose-700 ring-rose-200' },
  revision_requested: {
    label: 'Revision Requested',
    badge: 'bg-fuchsia-100 text-fuchsia-800 ring-fuchsia-200',
  },
};

const DECISION_META: Record<
  ReviewDecision,
  { label: string; confirm: string; classes: string }
> = {
  approved: {
    label: 'Approve',
    confirm: 'Approve & resolve',
    classes: 'bg-emerald-600 text-white hover:bg-emerald-700',
  },
  revision_requested: {
    label: 'Request revision',
    confirm: 'Send revision request',
    classes: 'bg-fuchsia-600 text-white hover:bg-fuchsia-700',
  },
  rejected: {
    label: 'Reject',
    confirm: 'Reject submission',
    classes: 'bg-rose-600 text-white hover:bg-rose-700',
  },
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function teamTypeLabel(teamType: string): string {
  return { student: 'Student team', ngo: 'NGO', institution: 'Institution' }[
    teamType
  ] ?? teamType;
}

/* ----------------------------------------------------------------------------
 * Review panel (inline per card)
 * -------------------------------------------------------------------------- */

interface ReviewPanelProps {
  solution: AdminSolution;
  adminUserId: string;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}

function ReviewPanel({ solution, adminUserId, onDone, onError }: ReviewPanelProps) {
  const [decision, setDecision] = useState<ReviewDecision | null>(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const submitReview = async () => {
    if (!decision) return;
    if (comment.trim().length < MIN_COMMENT) {
      setLocalError(`Review comment must be at least ${MIN_COMMENT} characters — this is part of the audit record.`);
      return;
    }
    setSubmitting(true);
    setLocalError(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${LIST_ENDPOINT}/${solution.id}/review`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-admin-id': adminUserId },
        body: JSON.stringify({ decision, reviewComment: comment.trim() }),
        signal: controller.signal,
      });
      const data = (await response.json().catch(() => null)) as {
        message?: string;
        error?: string;
        complaintAdvanced?: boolean;
      } | null;

      if (!response.ok) {
        onError(
          data?.error ?? `Review failed (HTTP ${response.status}). Please try again.`
        );
        return;
      }
      onDone(data?.message ?? 'Decision recorded.');
    } catch {
      onError(
        "We couldn't reach the server — check your connection and try again."
      );
    } finally {
      clearTimeout(timer);
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
      <p className="text-xs font-semibold text-slate-600">Review decision</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        {(Object.keys(DECISION_META) as ReviewDecision[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setDecision(key)}
            className={`rounded-xl px-3 py-2 text-xs font-bold ring-1 transition ${
              decision === key
                ? DECISION_META[key].classes
                : 'border border-slate-300 bg-white text-slate-600 ring-slate-200 hover:bg-slate-100'
            }`}
          >
            {DECISION_META[key].label}
          </button>
        ))}
      </div>

      <label
        htmlFor={`review-comment-${solution.id}`}
        className="mt-3 block text-xs font-semibold text-slate-600"
      >
        Mandatory review comment <span className="text-rose-500">*</span>
        <span className="float-right font-normal text-slate-400">
          {comment.trim().length}/{MIN_COMMENT}+ chars · stored on the record &amp; sent to the team
        </span>
      </label>
      <textarea
        id={`review-comment-${solution.id}`}
        rows={3}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder={
          decision === 'approved'
            ? 'Verification notes, testing performed, and why this prototype closes the complaint…'
            : 'Explain what must change before the next iteration…'
        }
        className="mt-1 w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200"
      />

      {localError && (
        <p className="mt-2 text-xs font-medium text-rose-600">{localError}</p>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => onError('')}
          disabled={submitting}
          className="rounded-full border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submitReview}
          disabled={!decision || submitting}
          className={`rounded-full px-4 py-1.5 text-xs font-bold shadow-sm transition disabled:cursor-not-allowed disabled:opacity-40 ${
            decision ? DECISION_META[decision].classes : 'bg-slate-300 text-slate-600'
          }`}
        >
          {submitting
            ? 'Recording…'
            : decision
              ? DECISION_META[decision].confirm
              : 'Select a decision first'}
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Verification queue
 * -------------------------------------------------------------------------- */

function VerificationQueue() {
  const searchParams = useSearchParams();
  const adminUserId = searchParams.get('admin') ?? '';

  const [solutions, setSolutions] = useState<AdminSolution[]>([]);
  const [statusFilter, setStatusFilter] = useState<SolutionStatus | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reviewOpenFor, setReviewOpenFor] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const fetchQueue = useCallback(async () => {
    if (!adminUserId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(LIST_ENDPOINT, {
        headers: { 'x-admin-id': adminUserId },
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(
          response.status === 401
            ? 'Authentication failed — pass a valid ?admin= govt_admin id.'
            : `The server returned HTTP ${response.status}.`
        );
      }
      const data = (await response.json()) as { solutions?: AdminSolution[] };
      setSolutions(Array.isArray(data.solutions) ? data.solutions : []);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : 'Failed to load the verification queue.'
      );
    } finally {
      setLoading(false);
    }
  }, [adminUserId]);

  useEffect(() => {
    fetchQueue();
  }, [fetchQueue]);

  const visible = useMemo(
    () =>
      statusFilter === 'all'
        ? solutions
        : solutions.filter((solution) => solution.status === statusFilter),
    [solutions, statusFilter]
  );

  const statusCounts = useMemo(() => {
    const counts: Record<SolutionStatus, number> = {
      draft: 0,
      submitted: 0,
      under_review: 0,
      approved: 0,
      rejected: 0,
      revision_requested: 0,
    };
    solutions.forEach((solution) => {
      counts[solution.status] += 1;
    });
    return counts;
  }, [solutions]);

  const handleReviewDone = (message: string) => {
    setReviewOpenFor(null);
    setFeedback({ tone: 'ok', text: message });
    fetchQueue();
  };

  const handleReviewError = (message: string) => {
    if (!message) {
      setReviewOpenFor(null);
      return;
    }
    setFeedback({ tone: 'error', text: message });
  };

  const renderSolution = (solution: AdminSolution) => {
    const meta = STATUS_META[solution.status] ?? STATUS_META.submitted;
    const reviewOpen = reviewOpenFor === solution.id;

    return (
      <div
        key={solution.id}
        className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <span>Iteration #{solution.iteration}</span>
              <span>·</span>
              <span>Solution #{solution.id}</span>
              <span>·</span>
              <span>Complaint #{solution.complaint.id}</span>
            </div>
            <h3 className="mt-1 text-sm font-bold text-slate-900">{solution.title}</h3>
            <p className="mt-0.5 line-clamp-1 text-xs text-slate-500">
              Problem: {solution.complaint.title}
            </p>
          </div>
          <span
            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${meta.badge}`}
          >
            {meta.label}
          </span>
        </div>

        {/* team context */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
          <span className="font-semibold">{solution.claim.teamName}</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium ring-1 ring-slate-200">
            {teamTypeLabel(solution.claim.teamType)}
          </span>
          {solution.claim.institutionName && (
            <span className="text-slate-500">{solution.claim.institutionName}</span>
          )}
          {solution.claim.teamLeadName && (
            <span className="text-slate-400">Lead: {solution.claim.teamLeadName}</span>
          )}
          <span className="ml-auto text-[11px] text-slate-400">
            Submitted {formatDate(solution.submittedAt)}
          </span>
        </div>

        <p className="mt-2 text-sm leading-relaxed text-slate-700">
          {solution.summary}
        </p>

        {/* tech stack */}
        {solution.techStack.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {solution.techStack.map((tech) => (
              <span
                key={tech}
                className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200"
              >
                {tech}
              </span>
            ))}
          </div>
        )}

        {/* verifiable links */}
        <div className="mt-3 flex flex-wrap gap-2">
          {solution.repositoryUrl && (
            <a
              href={solution.repositoryUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm hover:border-emerald-400 hover:bg-emerald-50"
            >
              ▒ Test repository ↗
            </a>
          )}
          {solution.prototypeUrl && (
            <a
              href={solution.prototypeUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-full bg-slate-900 px-3 py-1.5 text-xs font-bold text-white shadow-sm hover:bg-slate-700"
            >
              ▶ Test live demo ↗
            </a>
          )}
          {(solution.documentation ?? []).map((doc, index) => (
            <a
              key={`${doc.url}-${index}`}
              href={doc.url}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-700 hover:bg-violet-100"
            >
              📄 {doc.label || `Documentation ${index + 1}`} ↗
            </a>
          ))}
        </div>

        {/* prior review trail */}
        {solution.reviewedAt && (
          <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
            <span className="font-semibold text-slate-600">Last reviewed</span>{' '}
            {formatDate(solution.reviewedAt)}
            {solution.reviewComment && (
              <>
                {' '}
                · <span className="italic">“{solution.reviewComment}”</span>
              </>
            )}
          </p>
        )}

        {/* review actions */}
        <div className="mt-4 border-t border-slate-100 pt-3">
          {solution.status === 'approved' ? (
            <span className="text-xs font-bold text-emerald-600">
              ✓ Prototype verified — loop closed for this iteration
            </span>
          ) : (
            <>
              {!reviewOpen ? (
                <button
                  type="button"
                  onClick={() => {
                    setReviewOpenFor(solution.id);
                    setFeedback(null);
                  }}
                  className="rounded-full bg-slate-900 px-4 py-2 text-xs font-bold text-white shadow-sm hover:bg-slate-700"
                >
                  Review this iteration →
                </button>
              ) : (
                <ReviewPanel
                  solution={solution}
                  adminUserId={adminUserId}
                  onDone={handleReviewDone}
                  onError={handleReviewError}
                />
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-100">
      <main className="mx-auto w-full max-w-5xl px-4 py-8">
        {/* ---------- header ---------- */}
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-emerald-700">
              Module 7 · Prototype Verification & Loop Closure
            </p>
            <h1 className="mt-1 text-2xl font-bold text-slate-900 sm:text-3xl">
              Solution Verification Command Center
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-500">
              Review student and NGO prototypes, test their links, and close the
              loop — every decision is audited, and both the team lead and the
              original citizen are alerted.
            </p>
          </div>
          <button
            type="button"
            onClick={fetchQueue}
            disabled={loading}
            className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? 'Refreshing…' : '↻ Refresh'}
          </button>
        </header>

        {/* ---------- demo auth prompt ---------- */}
        {!adminUserId ? (
          <div className="mx-auto mt-10 max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
            <p className="text-3xl">🔐</p>
            <h2 className="mt-2 text-sm font-bold text-slate-700">
              Demo authentication required
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Open the command center with a govt_admin user id:
            </p>
            <code className="mt-3 inline-block rounded-lg bg-slate-100 px-3 py-1.5 font-mono text-xs text-emerald-700">
              /admin/solutions?admin=1
            </code>
          </div>
        ) : (
          <>
            {/* ---------- status tabs ---------- */}
            <nav className="mt-6 flex flex-wrap gap-2" aria-label="Filter by status">
              {STATUS_ORDER.map((status) => (
                <button
                  key={status}
                  type="button"
                  onClick={() => setStatusFilter(status)}
                  className={`rounded-full px-3.5 py-1.5 text-xs font-semibold ring-1 transition ${
                    statusFilter === status
                      ? 'bg-slate-900 text-white ring-slate-900'
                      : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {status === 'all'
                    ? `All · ${solutions.length}`
                    : `${STATUS_META[status].label} · ${statusCounts[status]}`}
                </button>
              ))}
            </nav>

            {/* ---------- feedback toast ---------- */}
            {feedback && (
              <div
                className={`mt-4 rounded-xl border px-4 py-3 text-sm font-medium ${
                  feedback.tone === 'ok'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : 'border-rose-200 bg-rose-50 text-rose-700'
                }`}
              >
                {feedback.text}
              </div>
            )}

            {/* ---------- queue ---------- */}
            {loading ? (
              <div className="mt-6 space-y-4">
                {Array.from({ length: 3 }).map((_, index) => (
                  <div
                    key={index}
                    className="h-48 animate-pulse rounded-2xl border border-slate-200 bg-slate-200/70"
                  />
                ))}
              </div>
            ) : loadError ? (
              <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-8 text-center">
                <p className="text-3xl">📡</p>
                <h2 className="mt-2 text-sm font-bold text-rose-800">
                  Could not load the verification queue
                </h2>
                <p className="mt-1 text-sm text-rose-700">{loadError}</p>
                <button
                  type="button"
                  onClick={fetchQueue}
                  className="mt-4 rounded-full bg-rose-600 px-5 py-2 text-sm font-semibold text-white hover:bg-rose-700"
                >
                  Retry
                </button>
              </div>
            ) : visible.length === 0 ? (
              <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
                <p className="text-4xl">🧪</p>
                <h2 className="mt-2 text-sm font-bold text-slate-700">
                  {solutions.length === 0
                    ? 'No prototype submissions yet'
                    : `No submissions in “${statusFilter}”`}
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  {solutions.length === 0
                    ? 'Submissions from approved teams will appear here for verification.'
                    : 'Try a different status tab.'}
                </p>
              </div>
            ) : (
              <div className="mt-6 space-y-4">{visible.map(renderSolution)}</div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Page — Suspense wrapper for useSearchParams
 * -------------------------------------------------------------------------- */

export default function AdminSolutionsPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen animate-pulse bg-slate-100" aria-busy="true" />
      }
    >
      <VerificationQueue />
    </Suspense>
  );
}
