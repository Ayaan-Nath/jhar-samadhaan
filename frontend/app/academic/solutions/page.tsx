'use client';

/* ============================================================================
 * Solution Submission Portal — Module 6
 * (app/academic/solutions/page.tsx)
 *
 * Dashboard where student/NGO teams holding APPROVED claims submit versioned
 * prototype iterations (title, summary >= 20 chars, tech-stack chips, doc
 * links, GitHub repo URL, live demo URL). Each submission lands with
 * status 'submitted' and is routed to the govt_admin verification queue.
 *
 * Data comes from /api/solutions:
 *   GET  /api/solutions (header x-user-id)  -> { claims: TeamClaim[] }
 *   POST /api/solutions (header x-user-id)  -> 201 { solution, message }
 *
 * DEMO AUTH: pass the acting team lead's user id as ?uid=NNN (mirrors the
 * x-user-id header auth used across the stack until sessions exist).
 * ==========================================================================*/

import {
  Suspense,
  useCallback,
  useEffect,
  useState,
} from 'react';
import { useSearchParams } from 'next/navigation';

/* ----------------------------------------------------------------------------
 * Types (mirror /api/solutions)
 * -------------------------------------------------------------------------- */

export interface SolutionSubmission {
  id: number;
  iteration: number;
  title: string;
  summary: string;
  techStack: string[];
  documentation: { label: string | null; url: string }[];
  repositoryUrl: string | null;
  prototypeUrl: string | null;
  status: 'draft' | 'submitted' | 'under_review' | 'approved' | 'rejected' | 'revision_requested';
  submittedAt: string;
}

export interface TeamClaim {
  claimId: number;
  complaintId: number;
  complaintTitle: string;
  teamName: string;
  submissions: SolutionSubmission[];
}

const API_ENDPOINT = '/api/solutions';
const REQUEST_TIMEOUT_MS = 15_000;
const MIN_SUMMARY = 20;

const SOLUTION_STATUS_META: Record<SolutionSubmission['status'], string> = {
  draft: 'bg-slate-100 text-slate-600 ring-slate-200',
  submitted: 'bg-sky-100 text-sky-800 ring-sky-200',
  under_review: 'bg-amber-100 text-amber-800 ring-amber-200',
  approved: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  rejected: 'bg-rose-100 text-rose-700 ring-rose-200',
  revision_requested: 'bg-fuchsia-100 text-fuchsia-800 ring-fuchsia-200',
};

const SOLUTION_STATUS_LABEL: Record<SolutionSubmission['status'], string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  under_review: 'Under Review',
  approved: 'Approved',
  rejected: 'Revision Needed',
  revision_requested: 'Revision Requested',
};

const URL_PATTERN = /^https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?(?:\/[^\s]*)?$/i;

function formatDate(iso: string): string {
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

/* ----------------------------------------------------------------------------
 * Submission modal (iteration form)
 * -------------------------------------------------------------------------- */

interface SubmitModalProps {
  claim: TeamClaim;
  userId: string;
  onClose: () => void;
  onSubmitted: () => void;
}

function SubmitModal({ claim, userId, onClose, onSubmitted }: SubmitModalProps) {
  const nextIteration =
    claim.submissions.reduce((max, s) => Math.max(max, s.iteration), 0) + 1;

  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [techStack, setTechStack] = useState<string[]>([]);
  const [techDraft, setTechDraft] = useState('');
  const [docLinks, setDocLinks] = useState<{ label: string; url: string }[]>([]);
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [prototypeUrl, setPrototypeUrl] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<{
    iteration: number;
    status: string;
  } | null>(null);

  const addTech = () => {
    const value = techDraft.trim();
    if (!value) return;
    if (techStack.includes(value)) {
      setTechDraft('');
      return;
    }
    setTechStack((prev) => [...prev, value]);
    setTechDraft('');
  };

  const removeTech = (index: number) => {
    setTechStack((prev) => prev.filter((_, i) => i !== index));
  };

  const addDocLink = () => setDocLinks((prev) => [...prev, { label: '', url: '' }]);
  const updateDocLink = (index: number, patch: Partial<{ label: string; url: string }>) =>
    setDocLinks((prev) => prev.map((link, i) => (i === index ? { ...link, ...patch } : link)));
  const removeDocLink = (index: number) =>
    setDocLinks((prev) => prev.filter((_, i) => i !== index));

  const validate = (): Record<string, string> => {
    const errors: Record<string, string> = {};
    if (!title.trim()) errors.title = 'Enter a title for this iteration.';
    else if (title.trim().length > 300) errors.title = 'Title must be at most 300 characters.';
    if (summary.trim().length < MIN_SUMMARY) {
      errors.summary = `Summary must be at least ${MIN_SUMMARY} characters.`;
    }
    if (techStack.length === 0) {
      errors.techStack = 'Add at least one technology to the stack.';
    }
    if (repositoryUrl.trim() && !URL_PATTERN.test(repositoryUrl.trim())) {
      errors.repositoryUrl = 'Repository URL must be a valid http(s) link (e.g. GitHub).';
    }
    if (prototypeUrl.trim() && !URL_PATTERN.test(prototypeUrl.trim())) {
      errors.prototypeUrl = 'Live demo URL must be a valid http(s) link.';
    }
    docLinks.forEach((link, index) => {
      if (link.url.trim() && !URL_PATTERN.test(link.url.trim())) {
        errors[`doc-${index}`] = `Doc link ${index + 1} must be a valid http(s) URL.`;
      }
    });
    return errors;
  };

  const handleSubmit = async () => {
    const errors = validate();
    setFieldErrors(errors);
    setServerError(null);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({
          claimId: claim.claimId,
          title: title.trim(),
          summary: summary.trim(),
          techStack,
          documentation: docLinks
            .filter((link) => link.url.trim())
            .map((link) => ({
              label: link.label.trim() || null,
              url: link.url.trim(),
            })),
          repositoryUrl: repositoryUrl.trim() || null,
          prototypeUrl: prototypeUrl.trim() || null,
        }),
        signal: controller.signal,
      });
      const data = (await response.json().catch(() => null)) as {
        solution?: { iteration: number; status: string };
        error?: string;
      } | null;

      if (!response.ok) {
        setServerError(
          data?.error ?? `Submission failed (HTTP ${response.status}). Please try again.`
        );
        return;
      }
      if (data?.solution) {
        setSuccess({ iteration: data.solution.iteration, status: data.solution.status });
        onSubmitted();
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

  const inputClass = (hasError: boolean) =>
    `w-full rounded-xl border px-3.5 py-2.5 text-sm text-slate-800 outline-none transition focus:ring-2 ${
      hasError
        ? 'border-rose-300 bg-rose-50 focus:border-rose-400 focus:ring-rose-200'
        : 'border-slate-300 bg-white focus:border-emerald-500 focus:ring-emerald-200'
    }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Submit prototype iteration ${nextIteration}`}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[92dvh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl sm:rounded-3xl"
      >
        {success ? (
          /* ---------------- success state ---------------- */
          <div className="py-8 text-center">
            <p className="text-4xl">🚀</p>
            <h2 className="mt-2 text-lg font-bold text-emerald-900">
              Prototype submitted!
            </h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-slate-600">
              Iteration{' '}
              <span className="font-semibold text-slate-800">#{success.iteration}</span>{' '}
              of “{claim.complaintTitle}” is now{' '}
              <span className="font-semibold text-sky-700">submitted</span> and has been
              routed to the government admin command center for prototype
              verification and loop closure.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-6 rounded-full bg-emerald-600 px-6 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-emerald-700"
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
                  Submit iteration #{nextIteration}
                </h2>
                <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">
                  Claim #{claim.claimId} · {claim.complaintTitle}
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

            <div className="mt-4 space-y-4">
              {/* title */}
              <div>
                <label htmlFor="sol-title" className="mb-1 block text-xs font-semibold text-slate-600">
                  Prototype title <span className="text-rose-500">*</span>
                </label>
                <input
                  id="sol-title"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. JalSetu — AI pipeline-leak alerting MVP"
                  className={inputClass(Boolean(fieldErrors.title))}
                />
                {fieldErrors.title && (
                  <p className="mt-1 text-xs font-medium text-rose-600">{fieldErrors.title}</p>
                )}
              </div>

              {/* summary */}
              <div>
                <div className="mb-1 flex items-baseline justify-between">
                  <label htmlFor="sol-summary" className="block text-xs font-semibold text-slate-600">
                    What changed in this iteration? <span className="text-rose-500">*</span>
                  </label>
                  <span
                    className={`text-[11px] ${
                      summary.trim().length >= MIN_SUMMARY ? 'text-emerald-600' : 'text-slate-400'
                    }`}
                  >
                    {summary.trim().length}/{MIN_SUMMARY}+ chars
                  </span>
                </div>
                <textarea
                  id="sol-summary"
                  rows={3}
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder="Describe the prototype functionality, verification steps for the admin team, and how it addresses the complaint…"
                  className={`${inputClass(Boolean(fieldErrors.summary))} resize-y`}
                />
                {fieldErrors.summary && (
                  <p className="mt-1 text-xs font-medium text-rose-600">{fieldErrors.summary}</p>
                )}
              </div>

              {/* tech stack chips */}
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-600">
                  Tech stack (JSON array) <span className="text-rose-500">*</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={techDraft}
                    onChange={(e) => setTechDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addTech();
                      }
                    }}
                    placeholder="e.g. Next.js, FastAPI, pgvector"
                    className={inputClass(Boolean(fieldErrors.techStack))}
                  />
                  <button
                    type="button"
                    onClick={addTech}
                    className="shrink-0 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50"
                  >
                    Add
                  </button>
                </div>
                {techStack.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {techStack.map((tech, index) => (
                      <span
                        key={`${tech}-${index}`}
                        className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200"
                      >
                        {tech}
                        <button
                          type="button"
                          onClick={() => removeTech(index)}
                          aria-label={`Remove ${tech}`}
                          className="text-emerald-600 hover:text-rose-600"
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {fieldErrors.techStack && (
                  <p className="mt-1 text-xs font-medium text-rose-600">{fieldErrors.techStack}</p>
                )}
              </div>

              {/* repo + demo */}
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="sol-repo" className="mb-1 block text-xs font-semibold text-slate-600">
                    GitHub repository URL
                  </label>
                  <input
                    id="sol-repo"
                    type="url"
                    value={repositoryUrl}
                    onChange={(e) => setRepositoryUrl(e.target.value)}
                    placeholder="https://github.com/org/repo"
                    className={inputClass(Boolean(fieldErrors.repositoryUrl))}
                  />
                  {fieldErrors.repositoryUrl && (
                    <p className="mt-1 text-xs font-medium text-rose-600">
                      {fieldErrors.repositoryUrl}
                    </p>
                  )}
                </div>
                <div>
                  <label htmlFor="sol-demo" className="mb-1 block text-xs font-semibold text-slate-600">
                    Live demo URL
                  </label>
                  <input
                    id="sol-demo"
                    type="url"
                    value={prototypeUrl}
                    onChange={(e) => setPrototypeUrl(e.target.value)}
                    placeholder="https://jalsetu-demo.vercel.app"
                    className={inputClass(Boolean(fieldErrors.prototypeUrl))}
                  />
                  {fieldErrors.prototypeUrl && (
                    <p className="mt-1 text-xs font-medium text-rose-600">
                      {fieldErrors.prototypeUrl}
                    </p>
                  )}
                </div>
              </div>

              {/* documentation links */}
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="block text-xs font-semibold text-slate-600">
                    Prototype documentation links
                  </label>
                  <button
                    type="button"
                    onClick={addDocLink}
                    className="text-xs font-semibold text-emerald-700 underline underline-offset-2"
                  >
                    + Add link
                  </button>
                </div>
                {docLinks.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-2.5 text-xs text-slate-400">
                    Design docs, PPT, demo video or whitepaper URLs — stored as a
                    structured array with the submission.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {docLinks.map((link, index) => (
                      <div key={index} className="flex items-center gap-2">
                        <input
                          type="text"
                          value={link.label}
                          onChange={(e) => updateDocLink(index, { label: e.target.value })}
                          placeholder="Label (e.g. Design doc)"
                          className={inputClass(false)}
                        />
                        <input
                          type="url"
                          value={link.url}
                          onChange={(e) => updateDocLink(index, { url: e.target.value })}
                          placeholder="https://…"
                          className={inputClass(Boolean(fieldErrors[`doc-${index}`]))}
                        />
                        <button
                          type="button"
                          onClick={() => removeDocLink(index)}
                          aria-label="Remove link"
                          className="shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-rose-600"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {Object.keys(fieldErrors)
                  .filter((key) => key.startsWith('doc-'))
                  .map((key) => (
                    <p key={key} className="mt-1 text-xs font-medium text-rose-600">
                      {fieldErrors[key]}
                    </p>
                  ))}
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
                {submitting
                  ? 'Submitting iteration…'
                  : `Submit iteration #${nextIteration} →`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Portal board
 * -------------------------------------------------------------------------- */

function SolutionsPortal() {
  const searchParams = useSearchParams();
  const userId = searchParams.get('uid') ?? '';

  const [claims, setClaims] = useState<TeamClaim[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modalClaim, setModalClaim] = useState<TeamClaim | null>(null);
  const [justSubmitted, setJustSubmitted] = useState<string | null>(null);

  const fetchClaims = useCallback(async () => {
    if (!userId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(API_ENDPOINT, {
        headers: { 'x-user-id': userId },
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(
          response.status === 401
            ? 'Authentication failed — pass a valid ?uid= team lead id.'
            : `The server returned HTTP ${response.status}.`
        );
      }
      const data = (await response.json()) as { claims?: TeamClaim[] };
      setClaims(Array.isArray(data.claims) ? data.claims : []);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : 'Failed to load your solutions.'
      );
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchClaims();
  }, [fetchClaims]);

  const handleSubmitted = (claimId: number) => {
    setJustSubmitted(String(claimId));
    fetchClaims();
  };

  const renderSubmission = (submission: SolutionSubmission) => {
    const statusClass = SOLUTION_STATUS_META[submission.status] ?? SOLUTION_STATUS_META.submitted;
    return (
      <div
        key={submission.id}
        className="rounded-xl border border-slate-200 bg-white p-3.5"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-600 text-xs font-bold text-white">
              {submission.iteration}
            </span>
            <p className="text-sm font-bold text-slate-800">{submission.title}</p>
          </div>
          <span
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ${statusClass}`}
          >
            {SOLUTION_STATUS_LABEL[submission.status]}
          </span>
        </div>
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-slate-600">
          {submission.summary}
        </p>
        {submission.techStack.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {submission.techStack.map((tech) => (
              <span
                key={tech}
                className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600"
              >
                {tech}
              </span>
            ))}
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {submission.repositoryUrl && (
            <a
              href={submission.repositoryUrl}
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-sky-700 hover:underline"
            >
              ▒ Repo
            </a>
          )}
          {submission.prototypeUrl && (
            <a
              href={submission.prototypeUrl}
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-emerald-700 hover:underline"
            >
              ▶ Live demo
            </a>
          )}
          {(submission.documentation ?? []).map((doc, index) => (
            <a
              key={`${doc.url}-${index}`}
              href={doc.url}
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-violet-700 hover:underline"
            >
              📄 {doc.label || `Doc ${index + 1}`}
            </a>
          ))}
          {submission.submittedAt && (
            <span className="ml-auto text-[11px] text-slate-400">
              {formatDate(submission.submittedAt)}
            </span>
          )}
        </div>
      </div>
    );
  };

  const renderClaimCard = (claim: TeamClaim) => {
    const nextIteration =
      claim.submissions.reduce((max, s) => Math.max(max, s.iteration), 0) + 1;
    return (
      <div
        key={claim.claimId}
        className="rounded-2xl border border-slate-200 bg-slate-50 p-4 shadow-sm"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span>Claim #{claim.claimId}</span>
              <span>·</span>
              <span>Complaint #{claim.complaintId}</span>
            </div>
            <h3 className="mt-1 text-sm font-bold text-slate-900">
              {claim.complaintTitle}
            </h3>
            <p className="text-xs text-slate-500">Adopted by {claim.teamName}</p>
          </div>
          <button
            type="button"
            onClick={() => setModalClaim(claim)}
            disabled={justSubmitted === String(claim.claimId)}
            className="rounded-full bg-emerald-600 px-4 py-2 text-xs font-bold text-white shadow-sm transition hover:bg-emerald-700 active:scale-[0.98] disabled:opacity-40"
          >
            {justSubmitted === String(claim.claimId)
              ? '✓ Submitted — refreshing'
              : `Submit iteration #${nextIteration}`}
          </button>
        </div>

        <div className="mt-3 space-y-2">
          {claim.submissions.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-300 bg-white px-3 py-3 text-center text-xs text-slate-400">
              No prototype iterations yet — submit the first one above.
            </p>
          ) : (
            claim.submissions.map(renderSubmission)
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-100">
      <main className="mx-auto w-full max-w-4xl px-4 py-8">
        {/* ---------- header ---------- */}
        <header className="text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-emerald-700">
            Module 6 · Prototype Verification & Loop Closure
          </p>
          <h1 className="mt-1 text-2xl font-bold text-slate-900 sm:text-3xl">
            Solution Submission Portal
          </h1>
          <p className="mx-auto mt-2 max-w-xl text-sm text-slate-500">
            Teams with approved claims submit versioned prototype documentation —
            each iteration is sent to the government admin command center for
            verification.
          </p>
        </header>

        {/* ---------- no uid prompt ---------- */}
        {!userId ? (
          <div className="mx-auto mt-10 max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
            <p className="text-3xl">🔐</p>
            <h2 className="mt-2 text-sm font-bold text-slate-700">
              Demo authentication required
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Open the portal with a team lead user id to load your approved
              claims:
            </p>
            <code className="mt-3 inline-block rounded-lg bg-slate-100 px-3 py-1.5 font-mono text-xs text-emerald-700">
              /academic/solutions?uid=1
            </code>
          </div>
        ) : loading ? (
          <div className="mt-8 space-y-4">
            {Array.from({ length: 2 }).map((_, index) => (
              <div
                key={index}
                className="h-40 animate-pulse rounded-2xl border border-slate-200 bg-slate-200/70"
              />
            ))}
          </div>
        ) : loadError ? (
          <div className="mx-auto mt-8 max-w-lg rounded-2xl border border-rose-200 bg-rose-50 p-6 text-center">
            <p className="text-3xl">📡</p>
            <h2 className="mt-2 text-sm font-bold text-rose-800">
              Could not load your claims
            </h2>
            <p className="mt-1 text-sm text-rose-700">{loadError}</p>
            <button
              type="button"
              onClick={fetchClaims}
              className="mt-4 rounded-full bg-rose-600 px-5 py-2 text-sm font-semibold text-white hover:bg-rose-700"
            >
              Retry
            </button>
          </div>
        ) : claims.length === 0 ? (
          <div className="mx-auto mt-8 max-w-lg rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
            <p className="text-4xl">🎓</p>
            <h2 className="mt-2 text-sm font-bold text-slate-700">
              No approved claims yet
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Once the government admin approves your adoption claim on the
              Opportunities Board, you can submit prototype iterations here.
            </p>
          </div>
        ) : (
          <div className="mt-8 space-y-4">{claims.map(renderClaimCard)}</div>
        )}
      </main>

      {/* ---------- submission modal (mounted only while open) ---------- */}
      {modalClaim && userId && (
        <SubmitModal
          claim={modalClaim}
          userId={userId}
          onClose={() => setModalClaim(null)}
          onSubmitted={() => handleSubmitted(modalClaim.claimId)}
        />
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Page — Suspense wrapper so useSearchParams can be used safely in Next.js
 * -------------------------------------------------------------------------- */

export default function SolutionsPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen animate-pulse bg-slate-100" aria-busy="true" />
      }
    >
      <SolutionsPortal />
    </Suspense>
  );
}
