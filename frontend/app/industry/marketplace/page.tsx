'use client';

/* ============================================================================
 * Industry & CSR Partnership Marketplace — Module 5
 * (app/industry/marketplace/page.tsx)
 *
 * Card-based dashboard where corporate CSR entities, startups, and MSMEs
 * browse govt-APPROVED academic prototypes and pledge formal commitments:
 * financial grants, technical mentorship, or pilot deployment infrastructure.
 *
 * Data comes from /api/industry/partnerships:
 *   GET  /api/industry/partnerships (header x-user-id)
 *        -> { solutions: CatalogSolution[], metrics: ImpactMetrics }
 *   POST /api/industry/partnerships (header x-user-id)
 *        -> 201 { partnership, notified, message }
 *
 * DEMO AUTH: pass the acting industry partner's user id as ?pid=NNN (mirrors
 * the x-user-id header auth used across the stack until sessions exist).
 * ==========================================================================*/

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useSearchParams } from 'next/navigation';

/* ----------------------------------------------------------------------------
 * Types (mirror /api/industry/partnerships)
 * -------------------------------------------------------------------------- */

export type PledgeType = 'grant' | 'mentorship' | 'pilot';

export interface MyPledge {
  id: number;
  pledgeType: PledgeType;
  amountInr: number | null;
  status: string;
  createdAt: string;
}

export interface CatalogSolution {
  solutionId: number;
  iteration: number;
  title: string;
  summary: string;
  techStack: string[];
  repositoryUrl: string | null;
  prototypeUrl: string | null;
  submittedAt: string;
  team: {
    claimId: number;
    teamName: string;
    teamType: 'student' | 'ngo' | 'institution';
    institutionName: string | null;
    teamLeadName: string | null;
  };
  complaint: {
    id: number;
    title: string;
    district: string | null;
    categoryCode: string;
    categoryName: string;
  };
  pledges: {
    total: number;
    active: number;
    byType: Record<PledgeType, number>;
    committedInr: number;
  };
  myPledges: MyPledge[];
}

export interface ImpactMetrics {
  totalPledges: number;
  activePledges: number;
  committedInr: number;
  partners: number;
  backedSolutions: number;
  byType: Record<PledgeType, number>;
  byPartnerType: { csr: number; startup: number; msme: number };
}

const API_ENDPOINT = '/api/industry/partnerships';
const REQUEST_TIMEOUT_MS = 15_000;
const MIN_DESCRIPTION = 20;

const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const PHONE_PATTERN = /^[+0-9][0-9() -]{6,19}$/;

const CATEGORY_ORDER = ['AGR', 'WAT', 'HLT', 'EDU', 'PWR', 'INF', 'SWM', 'OTH'];

const CATEGORY_META: Record<string, { label: string; classes: string; dot: string }> = {
  AGR: { label: 'Agriculture', classes: 'bg-lime-100 text-lime-800 ring-lime-200', dot: 'bg-lime-500' },
  WAT: { label: 'Water & Sanitation', classes: 'bg-sky-100 text-sky-800 ring-sky-200', dot: 'bg-sky-500' },
  HLT: { label: 'Health', classes: 'bg-rose-100 text-rose-800 ring-rose-200', dot: 'bg-rose-500' },
  EDU: { label: 'Education', classes: 'bg-amber-100 text-amber-800 ring-amber-200', dot: 'bg-amber-500' },
  PWR: { label: 'Power & Energy', classes: 'bg-yellow-100 text-yellow-800 ring-yellow-200', dot: 'bg-yellow-500' },
  INF: { label: 'Infrastructure', classes: 'bg-indigo-100 text-indigo-800 ring-indigo-200', dot: 'bg-indigo-500' },
  SWM: { label: 'Waste Mgmt', classes: 'bg-teal-100 text-teal-800 ring-teal-200', dot: 'bg-teal-500' },
  OTH: { label: 'Other', classes: 'bg-slate-200 text-slate-700 ring-slate-300', dot: 'bg-slate-400' },
};

const PLEDGE_META: Record<PledgeType, { label: string; icon: string; hint: string }> = {
  grant: {
    label: 'Financial grant',
    icon: '💰',
    hint: 'Committed funding (INR) to build and scale the prototype.',
  },
  mentorship: {
    label: 'Technical mentorship',
    icon: '🧭',
    hint: 'Engineers, domain experts, and guided technical support.',
  },
  pilot: {
    label: 'Pilot deployment',
    icon: '🚀',
    hint: 'Infrastructure & a real deployment site for field validation.',
  },
};

const SUPPORT_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All solutions' },
  { value: 'open', label: 'Open for backing' },
  { value: 'backed', label: 'Has active pledges' },
  { value: 'grant', label: '💰 Has a grant' },
  { value: 'mentorship', label: '🧭 Has mentorship' },
  { value: 'pilot', label: '🚀 Has a pilot' },
];

function formatInr(value: number): string {
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

function categoryMeta(code: string) {
  return CATEGORY_META[code] ?? CATEGORY_META.OTH;
}

/* ----------------------------------------------------------------------------
 * Pledge modal
 * -------------------------------------------------------------------------- */

interface PledgeModalProps {
  solution: CatalogSolution;
  partnerId: string;
  onClose: () => void;
  onCommitted: () => void;
}

function PledgeModal({ solution, partnerId, onClose, onCommitted }: PledgeModalProps) {
  const [pledgeType, setPledgeType] = useState<PledgeType>('grant');
  const [amount, setAmount] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<{
    id: number;
    pledgeType: PledgeType;
    amountInr: number | null;
  } | null>(null);

  const amountRequired = pledgeType === 'grant';

  const selectType = (type: PledgeType) => {
    setPledgeType(type);
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next.amount;
      return next;
    });
  };

  const validate = (): Record<string, string> => {
    const errors: Record<string, string> = {};
    const amountValue = amount.trim() === '' ? NaN : Number(amount);

    if (amountRequired) {
      if (amount.trim() === '' || !Number.isFinite(amountValue) || amountValue <= 0) {
        errors.amount = 'Enter the committed grant amount in ₹ (must be a positive number).';
      }
    } else if (amount.trim() !== '') {
      if (!Number.isFinite(amountValue) || amountValue <= 0) {
        errors.amount = 'In-kind value must be a positive number in ₹, or leave blank.';
      }
    }

    if (title.trim().length === 0) {
      errors.title = 'Add a short headline for this commitment.';
    } else if (title.trim().length > 200) {
      errors.title = 'Headline must be at most 200 characters.';
    }

    if (description.trim().length < MIN_DESCRIPTION) {
      errors.description = `Describe your commitment in at least ${MIN_DESCRIPTION} characters so the team and govt reviewers understand the offer.`;
    }

    const email = contactEmail.trim();
    if (!EMAIL_PATTERN.test(email)) {
      errors.contactEmail =
        'Provide a valid contact email — the team and govt reviewers use it to reach your organisation.';
    }
    const phone = contactPhone.trim();
    if (phone !== '' && !PHONE_PATTERN.test(phone)) {
      errors.contactPhone =
        'Enter a valid phone number (digits, spaces, +, - and parentheses only).';
    }
    return errors;
  };

  const submit = async () => {
    const errors = validate();
    setFieldErrors(errors);
    setServerError(null);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(API_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-user-id': partnerId,
          },
          body: JSON.stringify({
            solutionId: solution.solutionId,
            pledgeType,
            amountInr: amount.trim() === '' ? null : Number(amount),
            title: title.trim(),
            description: description.trim(),
            contactEmail: contactEmail.trim(),
            contactPhone: contactPhone.trim() === '' ? null : contactPhone.trim(),
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        partnership?: { id: number; pledgeType: PledgeType; amountInr: number | null };
      };

      if (!response.ok) {
        setServerError(
          data.error ??
            (response.status === 0
              ? 'Network error — check your connection and retry.'
              : 'The pledge could not be recorded. Please try again.')
        );
        return;
      }

      if (data.partnership) {
        setSuccess({
          id: data.partnership.id,
          pledgeType: data.partnership.pledgeType,
          amountInr: data.partnership.amountInr,
        });
      }
    } catch {
      setServerError(
        'Connection lost or request timed out. Your draft is still here — check your connection and retry.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const close = () => {
    if (submitting) return;
    onClose();
  };

  const amountLabel = amountRequired
    ? 'Grant amount (₹)'
    : 'In-kind value (₹, optional)';

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/60 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Back solution: ${solution.title}`}
      onClick={close}
    >
      <div
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-2xl sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        {/* ---------- success state ---------- */}
        {success ? (
          <div className="py-6 text-center">
            <p className="text-4xl">🤝</p>
            <h3 className="mt-3 text-lg font-bold text-slate-900">
              Pledge recorded!
            </h3>
            <p className="mx-auto mt-2 max-w-sm text-sm text-slate-500">
              <span className="font-semibold text-slate-700">
                {PLEDGE_META[success.pledgeType].icon}{' '}
                {PLEDGE_META[success.pledgeType].label}
                {success.amountInr
                  ? ` of ${formatInr(success.amountInr)}`
                  : ''}
              </span>{' '}
              is now <span className="font-semibold text-amber-700">pending</span>{' '}
              government matching. The adopting team and govt admins have been
              notified.
            </p>
            <div className="mx-auto mt-4 inline-block rounded-full bg-slate-100 px-4 py-1.5 font-mono text-xs text-slate-600">
              Pledge ID #{success.id}
            </div>
            <button
              type="button"
              onClick={() => {
                onCommitted();
                onClose();
              }}
              className="mt-6 rounded-full bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700"
            >
              Back to marketplace
            </button>
          </div>
        ) : (
          <>
            {/* ---------- header ---------- */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-indigo-600">
                  Partnership pledge
                </p>
                <h3 className="mt-0.5 truncate text-base font-bold text-slate-900">
                  {solution.title}
                </h3>
                <p className="text-xs text-slate-500">
                  by {solution.team.teamName}
                  {solution.team.institutionName
                    ? ` · ${solution.team.institutionName}`
                    : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* ---------- pledge type ---------- */}
            <div className="mt-4">
              <p className="text-xs font-semibold text-slate-700">Type of commitment</p>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {(Object.keys(PLEDGE_META) as PledgeType[]).map((type) => {
                  const active = pledgeType === type;
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => selectType(type)}
                      className={`rounded-xl border px-2 py-2.5 text-center transition ${
                        active
                          ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500'
                          : 'border-slate-200 bg-white hover:border-slate-300'
                      }`}
                    >
                      <span className="block text-lg">{PLEDGE_META[type].icon}</span>
                      <span
                        className={`mt-0.5 block text-[11px] font-semibold leading-tight ${
                          active ? 'text-indigo-800' : 'text-slate-600'
                        }`}
                      >
                        {PLEDGE_META[type].label}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[11px] text-slate-400">
                {PLEDGE_META[pledgeType].hint}
              </p>
            </div>

            {/* ---------- form fields ---------- */}
            <div className="mt-4 space-y-3">
              <div>
                <label
                  htmlFor="pledge-amount"
                  className="flex items-center justify-between text-xs font-semibold text-slate-700"
                >
                  <span>
                    {amountLabel}
                    {amountRequired && <span className="ml-0.5 text-rose-500">*</span>}
                  </span>
                  <span className="font-normal text-slate-400">
                    {amountRequired ? 'required for grants' : 'approx. value accepted'}
                  </span>
                </label>
                <div className="relative mt-1.5">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-slate-400">
                    ₹
                  </span>
                  <input
                    id="pledge-amount"
                    type="number"
                    min="1"
                    step="0.01"
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    placeholder={amountRequired ? 'e.g. 250000' : 'e.g. 50000 (optional)'}
                    className={`w-full rounded-xl border bg-white py-2 pl-8 pr-3 text-sm text-slate-800 outline-none transition placeholder:text-slate-300 focus:ring-2 ${
                      fieldErrors.amount
                        ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-100'
                        : 'border-slate-200 focus:border-indigo-400 focus:ring-indigo-100'
                    }`}
                  />
                </div>
                {fieldErrors.amount && (
                  <p className="mt-1 text-xs text-rose-600">{fieldErrors.amount}</p>
                )}
              </div>

              <div>
                <label
                  htmlFor="pledge-title"
                  className="text-xs font-semibold text-slate-700"
                >
                  Commitment headline <span className="text-rose-500">*</span>
                </label>
                <input
                  id="pledge-title"
                  type="text"
                  maxLength={200}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="e.g. ₹2.5L seed grant + lab access for field testing"
                  className={`mt-1.5 w-full rounded-xl border bg-white px-3 py-2 text-sm text-slate-800 outline-none transition placeholder:text-slate-300 focus:ring-2 ${
                    fieldErrors.title
                      ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-100'
                      : 'border-slate-200 focus:border-indigo-400 focus:ring-indigo-100'
                  }`}
                />
                {fieldErrors.title && (
                  <p className="mt-1 text-xs text-rose-600">{fieldErrors.title}</p>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="pledge-description"
                    className="text-xs font-semibold text-slate-700"
                  >
                    Formal commitment <span className="text-rose-500">*</span>
                  </label>
                  <span
                    className={`text-[11px] ${
                      description.trim().length >= MIN_DESCRIPTION
                        ? 'text-emerald-600'
                        : 'text-slate-400'
                    }`}
                  >
                    {description.trim().length}/{MIN_DESCRIPTION}+ chars
                  </span>
                </div>
                <textarea
                  id="pledge-description"
                  rows={4}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Outline what your organisation will provide — funds, expert hours, equipment, pilot site, success metrics, and the timeline under the partnership."
                  className={`mt-1.5 w-full resize-none rounded-xl border bg-white px-3 py-2 text-sm text-slate-800 outline-none transition placeholder:text-slate-300 focus:ring-2 ${
                    fieldErrors.description
                      ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-100'
                      : 'border-slate-200 focus:border-indigo-400 focus:ring-indigo-100'
                  }`}
                />
                {fieldErrors.description && (
                  <p className="mt-1 text-xs text-rose-600">{fieldErrors.description}</p>
                )}
              </div>

              {/* ---------- point-of-contact ---------- */}
              <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-slate-700">
                    Contact details
                  </p>
                  <span className="text-[11px] text-slate-400">
                    shared with the team &amp; govt reviewers for matching
                  </span>
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <div>
                    <input
                      id="pledge-contact-email"
                      type="email"
                      value={contactEmail}
                      onChange={(event) => setContactEmail(event.target.value)}
                      placeholder="contact@company.in"
                      aria-label="Contact email"
                      className={`w-full rounded-xl border bg-white px-3 py-2 text-sm text-slate-800 outline-none transition placeholder:text-slate-300 focus:ring-2 ${
                        fieldErrors.contactEmail
                          ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-100'
                          : 'border-slate-200 focus:border-indigo-400 focus:ring-indigo-100'
                      }`}
                    />
                    {fieldErrors.contactEmail ? (
                      <p className="mt-1 text-xs text-rose-600">
                        {fieldErrors.contactEmail}
                      </p>
                    ) : (
                      <p className="mt-1 text-[11px] text-slate-400">
                        Email <span className="text-rose-500">*</span>
                      </p>
                    )}
                  </div>
                  <div>
                    <input
                      id="pledge-contact-phone"
                      type="tel"
                      value={contactPhone}
                      onChange={(event) => setContactPhone(event.target.value)}
                      placeholder="+91 98765 43210"
                      aria-label="Contact phone"
                      className={`w-full rounded-xl border bg-white px-3 py-2 text-sm text-slate-800 outline-none transition placeholder:text-slate-300 focus:ring-2 ${
                        fieldErrors.contactPhone
                          ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-100'
                          : 'border-slate-200 focus:border-indigo-400 focus:ring-indigo-100'
                      }`}
                    />
                    {fieldErrors.contactPhone ? (
                      <p className="mt-1 text-xs text-rose-600">
                        {fieldErrors.contactPhone}
                      </p>
                    ) : (
                      <p className="mt-1 text-[11px] text-slate-400">Phone (optional)</p>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {serverError && (
              <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {serverError}
              </p>
            )}

            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={close}
                disabled={submitting}
                className="flex-1 rounded-full border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={submitting}
                className="flex-[2] rounded-full bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 active:scale-[0.99] disabled:opacity-50"
              >
                {submitting ? 'Recording pledge…' : 'Submit formal pledge'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Marketplace (inner — reads ?pid= demo auth)
 * -------------------------------------------------------------------------- */

function IndustryMarketplace() {
  const searchParams = useSearchParams();
  const partnerId = searchParams.get('pid') ?? '';

  const [catalog, setCatalog] = useState<CatalogSolution[]>([]);
  const [metrics, setMetrics] = useState<ImpactMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [supportFilter, setSupportFilter] = useState<string>('all');
  const [techFilter, setTechFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [pledgeFor, setPledgeFor] = useState<CatalogSolution | null>(null);
  const [justCommitted, setJustCommitted] = useState<number | null>(null);

  const fetchCatalog = useCallback(async () => {
    if (!partnerId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(API_ENDPOINT, {
          headers: { 'x-user-id': partnerId },
          signal: controller.signal,
          cache: 'no-store',
        });
      } finally {
        clearTimeout(timer);
      }
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        solutions?: CatalogSolution[];
        metrics?: ImpactMetrics;
      };
      if (!response.ok) {
        setLoadError(
          data.error ??
            (response.status === 0
              ? 'Network error — is the API reachable?'
              : `Request failed (${response.status}).`)
        );
        return;
      }
      setCatalog(data.solutions ?? []);
      setMetrics(data.metrics ?? null);
    } catch {
      setLoadError(
        'Connection lost or request timed out while loading the marketplace. Retry when online.'
      );
    } finally {
      setLoading(false);
    }
  }, [partnerId]);

  useEffect(() => {
    fetchCatalog();
  }, [fetchCatalog]);

  /* ---- distinct tech stack options across the catalog ---------------------- */
  const techOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const solution of catalog) {
      for (const tech of solution.techStack) {
        const key = tech.trim();
        if (key) seen.add(key);
      }
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [catalog]);

  /* ---- client-side filtering (snappy tabs, accurate counts) ----------------- */
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const solution of catalog) {
      const code = solution.complaint.categoryCode;
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    return counts;
  }, [catalog]);

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return catalog.filter((solution) => {
      if (categoryFilter !== 'all' && solution.complaint.categoryCode !== categoryFilter) {
        return false;
      }
      if (supportFilter === 'open' && solution.pledges.total > 0) return false;
      if (supportFilter === 'backed' && solution.pledges.total === 0) return false;
      if (supportFilter === 'grant' && solution.pledges.byType.grant === 0) return false;
      if (supportFilter === 'mentorship' && solution.pledges.byType.mentorship === 0) return false;
      if (supportFilter === 'pilot' && solution.pledges.byType.pilot === 0) return false;
      if (techFilter !== 'all' && !solution.techStack.includes(techFilter)) return false;
      if (query) {
        const haystack = [
          solution.title,
          solution.summary,
          solution.complaint.title,
          solution.team.teamName,
          solution.team.institutionName ?? '',
          solution.techStack.join(' '),
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [catalog, categoryFilter, supportFilter, techFilter, searchQuery]);

  const availableCategories = CATEGORY_ORDER.filter((code) => categoryCounts.has(code));

  const renderPledgeBadge = (solution: CatalogSolution) => {
    const p = solution.pledges;
    const mine = solution.myPledges;
    const mineTypes = mine
      .map((pledge) => PLEDGE_META[pledge.pledgeType].label)
      .join(', ');

    if (p.total === 0) {
      return (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Open for partnership
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            Seeking grants, mentorship &amp; pilot support
          </p>
        </div>
      );
    }

    const badge =
      p.active > 0
        ? 'bg-emerald-100 text-emerald-800 ring-emerald-200'
        : 'bg-amber-100 text-amber-800 ring-amber-200';

    return (
      <div
        className={`rounded-xl px-3 py-2 ring-1 ${badge}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
          <p className="text-[11px] font-bold uppercase tracking-wide">
            {p.active > 0 ? 'Backed' : 'Pending matching'}
          </p>
          <p className="text-xs font-semibold">
            {p.committedInr > 0 ? `${formatInr(p.committedInr)} committed` : 'In-kind pledges'}
          </p>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
          {(['grant', 'mentorship', 'pilot'] as PledgeType[]).map((type) =>
            p.byType[type] > 0 ? (
              <span key={type} className="font-medium opacity-80">
                {PLEDGE_META[type].icon} {p.byType[type]}{' '}
                {p.byType[type] === 1
                  ? PLEDGE_META[type].label.split(' ').pop()
                  : PLEDGE_META[type].label.split(' ').pop() + 's'}
              </span>
            ) : null
          )}
          {p.total > 0 && <span className="opacity-70">· {p.total} pledge{p.total === 1 ? '' : 's'}</span>}
        </div>
        {mine.length > 0 && (
          <p className="mt-1 text-[11px] font-semibold text-indigo-700">
            🏷️ Backed by you — {mineTypes} ({mine[0].status})
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-100">
      <main className="mx-auto w-full max-w-6xl px-4 py-8">
        {/* ---------- header ---------- */}
        <header className="text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-indigo-700">
            Module 5 · Industry &amp; CSR Partnership
          </p>
          <h1 className="mt-1 text-2xl font-bold text-slate-900 sm:text-3xl">
            Innovation Funding Marketplace
          </h1>
          <p className="mx-auto mt-2 max-w-2xl text-sm text-slate-500">
            Browse govt-validated student &amp; NGO prototypes from Jharkhand and pledge
            financial grants, technical mentorship, or pilot deployment infrastructure —
            every commitment is routed to the team and the state admin command center.
          </p>
        </header>

        {/* ---------- demo auth gate ---------- */}
        {!partnerId ? (
          <div className="mx-auto mt-10 max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
            <p className="text-3xl">🏢</p>
            <h2 className="mt-2 text-sm font-bold text-slate-700">
              Demo authentication required
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Open the marketplace signed in as a CSR, startup, or MSME partner:
            </p>
            <code className="mt-3 inline-block rounded-lg bg-slate-100 px-3 py-1.5 font-mono text-xs text-indigo-700">
              /industry/marketplace?pid=2
            </code>
            <p className="mt-3 text-[11px] text-slate-400">
              Demo user ids: csr=2 · startup=3 · msme=4 (see seed)
            </p>
          </div>
        ) : loading ? (
          <div className="mt-8 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, index) => (
                <div
                  key={index}
                  className="h-24 animate-pulse rounded-2xl border border-slate-200 bg-slate-200/70"
                />
              ))}
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {Array.from({ length: 4 }).map((_, index) => (
                <div
                  key={index}
                  className="h-64 animate-pulse rounded-2xl border border-slate-200 bg-slate-200/70"
                />
              ))}
            </div>
          </div>
        ) : loadError ? (
          <div className="mx-auto mt-8 max-w-lg rounded-2xl border border-rose-200 bg-rose-50 p-6 text-center">
            <p className="text-3xl">📡</p>
            <h2 className="mt-2 text-sm font-bold text-rose-800">
              Could not load the marketplace
            </h2>
            <p className="mt-1 text-sm text-rose-700">{loadError}</p>
            <button
              type="button"
              onClick={fetchCatalog}
              className="mt-4 rounded-full bg-rose-600 px-5 py-2 text-sm font-semibold text-white hover:bg-rose-700"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            {/* ---------- impact metrics strip ---------- */}
            {metrics && (
              <section className="mt-8">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      Committed funding
                    </p>
                    <p className="mt-1 text-xl font-bold text-slate-900">
                      {formatInr(metrics.committedInr)}
                    </p>
                    <p className="text-[11px] text-slate-400">
                      across {metrics.totalPledges} pledge{metrics.totalPledges === 1 ? '' : 's'}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      Active pledges
                    </p>
                    <p className="mt-1 text-xl font-bold text-slate-900">
                      {metrics.activePledges}
                    </p>
                    <p className="text-[11px] text-slate-400">
                      {metrics.backedSolutions} solution{metrics.backedSolutions === 1 ? '' : 's'} backed
                    </p>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      Corporate partners
                    </p>
                    <p className="mt-1 text-xl font-bold text-slate-900">{metrics.partners}</p>
                    <p className="text-[11px] text-slate-400">
                      {metrics.byPartnerType.csr} CSR · {metrics.byPartnerType.startup} startup ·{' '}
                      {metrics.byPartnerType.msme} MSME
                    </p>
                  </div>
                  <div className="rounded-2xl border border-indigo-100 bg-indigo-50/60 p-4 shadow-sm">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-500">
                      Pledges by type
                    </p>
                    <div className="mt-1.5 space-y-1 text-xs font-medium text-slate-700">
                      <p>💰 {metrics.byType.grant} financial grant{metrics.byType.grant === 1 ? '' : 's'}</p>
                      <p>🧭 {metrics.byType.mentorship} mentorship{metrics.byType.mentorship === 1 ? '' : 's'}</p>
                      <p>🚀 {metrics.byType.pilot} pilot{metrics.byType.pilot === 1 ? '' : 's'}</p>
                    </div>
                  </div>
                </div>
                <p className="mt-2 text-center text-[11px] text-slate-400">
                  These corporate engagement metrics feed the state administrator impact dashboard.
                </p>
              </section>
            )}

            {/* ---------- filters ---------- */}
            <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setCategoryFilter('all')}
                      className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                        categoryFilter === 'all'
                          ? 'bg-slate-900 text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      All domains
                    </button>
                    {availableCategories.map((code) => {
                      const meta = categoryMeta(code);
                      const active = categoryFilter === code;
                      return (
                        <button
                          key={code}
                          type="button"
                          onClick={() =>
                            setCategoryFilter((prev) => (prev === code ? 'all' : code))
                          }
                          className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                            active
                              ? `${meta.classes} ring-2 ring-current`
                              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                          }`}
                        >
                          <span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                          {meta.label} · {categoryCounts.get(code) ?? 0}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-xs font-medium text-slate-400">
                    Showing {filtered.length} of {catalog.length}
                  </p>
                </div>

                <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search title, problem, team, or technology…"
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:ring-2 focus:ring-indigo-100"
                  />
                  <select
                    value={techFilter}
                    onChange={(event) => setTechFilter(event.target.value)}
                    aria-label="Filter by tech stack"
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                  >
                    <option value="all">All tech stacks</option>
                    {techOptions.map((tech) => (
                      <option key={tech} value={tech}>
                        {tech}
                      </option>
                    ))}
                  </select>
                  <select
                    value={supportFilter}
                    onChange={(event) => setSupportFilter(event.target.value)}
                    aria-label="Filter by funding or mentorship status"
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 sm:w-auto"
                  >
                    {SUPPORT_FILTERS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </section>

            {/* ---------- catalog grid ---------- */}
            {filtered.length === 0 ? (
              <div className="mx-auto mt-10 max-w-lg rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
                <p className="text-4xl">🔎</p>
                <h2 className="mt-2 text-sm font-bold text-slate-700">
                  No solutions match these filters
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  Try clearing the tech stack, domain, or support-state filter.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setCategoryFilter('all');
                    setSupportFilter('all');
                    setTechFilter('all');
                    setSearchQuery('');
                  }}
                  className="mt-4 rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white hover:bg-slate-700"
                >
                  Clear all filters
                </button>
              </div>
            ) : (
              <section className="mt-6 grid gap-4 md:grid-cols-2">
                {filtered.map((solution) => {
                  const meta = categoryMeta(solution.complaint.categoryCode);
                  return (
                    <article
                      key={solution.solutionId}
                      className="flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <span
                            className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ring-1 ${meta.classes}`}
                          >
                            {solution.complaint.categoryCode}
                          </span>
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                            Iteration {solution.iteration}
                          </span>
                        </div>
                        <span className="text-[11px] text-slate-400">
                          Approved {formatDate(solution.submittedAt)}
                        </span>
                      </div>

                      <h3 className="mt-3 text-base font-bold leading-snug text-slate-900">
                        {solution.title}
                      </h3>
                      <p className="mt-0.5 text-xs text-slate-500">
                        Complaint #{solution.complaint.id} — {solution.complaint.title}
                      </p>
                      <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-slate-600">
                        {solution.summary}
                      </p>

                      {solution.techStack.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {solution.techStack.slice(0, 8).map((tech) => (
                            <span
                              key={tech}
                              className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-600"
                            >
                              {tech}
                            </span>
                          ))}
                          {solution.techStack.length > 8 && (
                            <span className="px-1 text-[11px] text-slate-400">
                              +{solution.techStack.length - 8} more
                            </span>
                          )}
                        </div>
                      )}

                      <div className="mt-3 text-xs text-slate-500">
                        📍 {solution.complaint.district ?? 'Jharkhand'} ·{' '}
                        <span className="font-semibold text-slate-600">
                          {solution.team.teamName}
                        </span>
                        {solution.team.institutionName
                          ? ` (${solution.team.institutionName})`
                          : ''}
                      </div>

                      <div className="mt-3">{renderPledgeBadge(solution)}</div>

                      <div className="mt-4 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setPledgeFor(solution)}
                          disabled={justCommitted === solution.solutionId}
                          className="flex-1 rounded-full bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-indigo-700 active:scale-[0.98] disabled:opacity-40"
                        >
                          {justCommitted === solution.solutionId
                            ? '✓ Pledge recorded'
                            : 'Back this solution'}
                        </button>
                        {solution.repositoryUrl && (
                          <a
                            href={solution.repositoryUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded-full border border-slate-200 px-3 py-2.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
                            title="Review the prototype repository"
                          >
                            Repo ↗
                          </a>
                        )}
                        {solution.prototypeUrl && (
                          <a
                            href={solution.prototypeUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded-full border border-slate-200 px-3 py-2.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
                            title="Open the live demo"
                          >
                            Demo ↗
                          </a>
                        )}
                      </div>
                    </article>
                  );
                })}
              </section>
            )}
          </>
        )}
      </main>

      {/* ---------- pledge modal (mounted only while open) ---------- */}
      {pledgeFor && partnerId && (
        <PledgeModal
          solution={pledgeFor}
          partnerId={partnerId}
          onClose={() => setPledgeFor(null)}
          onCommitted={() => {
            setJustCommitted(pledgeFor.solutionId);
            fetchCatalog();
            window.setTimeout(
              () =>
                setJustCommitted((prev) =>
                  prev === pledgeFor.solutionId ? null : prev
                ),
              2500
            );
          }}
        />
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Page — Suspense wrapper so useSearchParams can be used safely in Next.js
 * -------------------------------------------------------------------------- */

export default function IndustryMarketplacePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen animate-pulse bg-slate-100" aria-busy="true" />
      }
    >
      <IndustryMarketplace />
    </Suspense>
  );
}
