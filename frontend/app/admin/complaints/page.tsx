'use client';

/* ============================================================================
 * Government Admin Dashboard - Complaint Queue
 * (app/admin/complaints/page.tsx)
 *
 * Renders a filterable card/table queue of complaints, grouped by workflow
 * status and domain category, with duplicate-cluster metrics and a one-click
 * "advance status" control (Submitted -> Under Review -> Assigned ->
 * In Progress -> Resolved) that captures an optional status_reason.
 *
 * Data contract — the page talks to two admin API routes (not yet built in
 * this repo, so the page shows a friendly retryable error until they exist):
 *
 *   GET  /api/admin/complaints
 *        -> { complaints: AdminComplaint[] }  (recent set; the page filters
 *        by status/category/search/duplicates client-side so tab counts stay
 *        accurate). The route must join categories + users and HONOR
 *        is_anonymous by omitting reporter identity for anonymous reports.
 *        Evidence photo URLs point at the WebP files under /public/uploads.
 *
 *   POST /api/admin/complaints/:id/advance
 *        body: { nextStatus, statusReason? }, header: x-admin-id
 *        The route UPDATEs complaints SET status = $n, updated_by = adminId,
 *        status_reason = ...; the DB trigger (fn_complaints_status_guard)
 *        validates the linear transition and writes the status_logs audit
 *        row automatically. Illegal transitions -> 409.
 *
 * NOTE ON AUTH: header-based admin id (x-admin-id) mirrors the demo auth in
 * the intake route — replace with a real session/role check before go-live.
 * ==========================================================================*/

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';

/* ----------------------------------------------------------------------------
 * Types (mirror what the admin API will return)
 * -------------------------------------------------------------------------- */

export type ComplaintStatus =
  | 'submitted'
  | 'under_review'
  | 'assigned'
  | 'in_progress'
  | 'resolved';

export interface AdminEvidenceImage {
  url: string;
  size?: number;
}

export interface AdminComplaint {
  id: number;
  title: string;
  description: string;
  status: ComplaintStatus;
  createdAt: string;
  updatedAt?: string;
  category: { code: string; label: string };
  district?: string | null;
  location: { latitude: number; longitude: number } | null;
  reporter: {
    isAnonymous: boolean;
    displayName: string | null; // already omitted by the API when anonymous
  } | null;
  images: AdminEvidenceImage[];
  /** Set when this complaint is a duplicate of another (child row). */
  cluster: { parentId: number; score: number } | null;
  /** Member count shown when this complaint is the head of a cluster. */
  clusterMembers: number;
  statusReason?: string | null;
}

/* ----------------------------------------------------------------------------
 * Constants
 * -------------------------------------------------------------------------- */

const STATUS_ORDER: ComplaintStatus[] = [
  'submitted',
  'under_review',
  'assigned',
  'in_progress',
  'resolved',
];

const STATUS_META: Record<
  ComplaintStatus,
  { label: string; badge: string; dot: string }
> = {
  submitted: {
    label: 'Submitted',
    badge: 'bg-slate-100 text-slate-700 ring-slate-200',
    dot: 'bg-slate-400',
  },
  under_review: {
    label: 'Under Review',
    badge: 'bg-sky-100 text-sky-800 ring-sky-200',
    dot: 'bg-sky-500',
  },
  assigned: {
    label: 'Assigned',
    badge: 'bg-violet-100 text-violet-800 ring-violet-200',
    dot: 'bg-violet-500',
  },
  in_progress: {
    label: 'In Progress',
    badge: 'bg-amber-100 text-amber-800 ring-amber-200',
    dot: 'bg-amber-500',
  },
  resolved: {
    label: 'Resolved',
    badge: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
    dot: 'bg-emerald-500',
  },
};

/** Next step in the linear state machine, per status. */
const NEXT_ACTION: Partial<
  Record<ComplaintStatus, { status: ComplaintStatus; label: string }>
> = {
  submitted: { status: 'under_review', label: 'Start review' },
  under_review: { status: 'assigned', label: 'Assign to team' },
  assigned: { status: 'in_progress', label: 'Start work' },
  in_progress: { status: 'resolved', label: 'Mark resolved' },
};

const CATEGORY_OPTIONS: { code: string; label: string }[] = [
  { code: 'AGR', label: 'Agriculture & Farmer Welfare' },
  { code: 'WAT', label: 'Water & Sanitation' },
  { code: 'HLT', label: 'Health & Wellness' },
  { code: 'EDU', label: 'Education & Skill Development' },
  { code: 'PWR', label: 'Energy & Electricity' },
  { code: 'INF', label: 'Roads & Infrastructure' },
  { code: 'SWM', label: 'Waste Management' },
  { code: 'OTH', label: 'Something else' },
];

const LIST_ENDPOINT = '/api/admin/complaints';
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
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}

/* ----------------------------------------------------------------------------
 * UI atoms
 * -------------------------------------------------------------------------- */

function StatusBadge({ status }: { status: ComplaintStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${meta.badge}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  );
}

function ClusterChip({ complaint }: { complaint: AdminComplaint }) {
  if (complaint.cluster) {
    return (
      <span
        title="This report was matched as a semantic duplicate"
        className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-semibold text-orange-800 ring-1 ring-orange-200"
      >
        🔁 dup of #{complaint.cluster.parentId} ·{' '}
        {Math.round(complaint.cluster.score * 100)}%
      </span>
    );
  }
  if (complaint.clusterMembers > 0) {
    return (
      <span
        title="This is the head of a duplicate cluster"
        className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-semibold text-indigo-800 ring-1 ring-indigo-200"
      >
        🗂 cluster head · {complaint.clusterMembers} linked report
        {complaint.clusterMembers > 1 ? 's' : ''}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 ring-1 ring-slate-200">
      unique
    </span>
  );
}

function ReporterLine({
  complaint,
}: {
  complaint: AdminComplaint;
}) {
  if (!complaint.reporter) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-slate-500">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-200 text-xs">
          —
        </span>
        No reporter
      </span>
    );
  }
  if (complaint.reporter.isAnonymous || !complaint.reporter.displayName) {
    return (
      <span
        title="Identity protected"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-700 text-xs text-white">
          🕶
        </span>
        Anonymous citizen
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700">
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700">
        {complaint.reporter.displayName
          .split(/\s+/)
          .slice(0, 2)
          .map((part) => part[0])
          .join('')
          .toUpperCase()}
      </span>
      {complaint.reporter.displayName}
    </span>
  );
}

function LocationLine({
  complaint,
}: {
  complaint: AdminComplaint;
}) {
  const loc = complaint.location;
  if (!loc) {
    return (
      <span className="text-sm text-slate-500">📍 No coordinates captured</span>
    );
  }
  const label = `${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}`;
  return (
    <a
      href={`https://maps.google.com/?q=${loc.latitude},${loc.longitude}`}
      target="_blank"
      rel="noreferrer"
      title="Open in Google Maps"
      className="inline-flex max-w-full items-center gap-1 text-sm text-sky-700 hover:underline"
    >
      📍 {complaint.district ? `${complaint.district} · ` : ''}
      <span className="truncate font-mono text-xs">{label}</span>
    </a>
  );
}

/* ----------------------------------------------------------------------------
 * Page
 * -------------------------------------------------------------------------- */

type ViewMode = 'cards' | 'table';

function ComplaintQueue() {
  /* ---- filters ---------------------------------------------------------- */
  const [statusFilter, setStatusFilter] = useState<ComplaintStatus | 'all'>('all');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('cards');

  /* ---- data ------------------------------------------------------------- */
  const [complaints, setComplaints] = useState<AdminComplaint[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadVersion = useRef(0);

  /* ---- per-row action state --------------------------------------------- */
  const [noteOpenFor, setNoteOpenFor] = useState<number | null>(null);
  const [noteText, setNoteText] = useState('');
  const [advancingId, setAdvancingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<{ id: number; message: string } | null>(null);

  // DEMO AUTH: the hub opens this page as /admin/complaints?admin=1; the id is
  // forwarded as the x-admin-id header, mirroring the analytics + verification
  // pages. Replace with real session auth before go-live.
  const adminUserId = useSearchParams().get('admin') ?? '';

  /* ---- fetching (API returns the recent set; filtering happens client-side so
          status tabs keep accurate counts and stay instant) ------------------ */
  const fetchComplaints = useCallback(async () => {
    const version = ++loadVersion.current;
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
          response.status === 404
            ? 'The admin complaints API (GET /api/admin/complaints) is not implemented yet — build it, then retry.'
            : `The server returned HTTP ${response.status}.`
        );
      }
      const data = (await response.json()) as { complaints?: AdminComplaint[] };
      if (version !== loadVersion.current) return; // stale response
      setComplaints(Array.isArray(data.complaints) ? data.complaints : []);
    } catch (error) {
      if (version !== loadVersion.current) return;
      setComplaints([]);
      setLoadError(
        error instanceof Error
          ? error.message
          : 'Failed to load complaints. Check your connection and retry.'
      );
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchComplaints();
  }, [fetchComplaints]);

  /* ---- derived metrics ---------------------------------------------------- */
  const filteredComplaints = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return complaints.filter((complaint) => {
      if (statusFilter !== 'all' && complaint.status !== statusFilter) return false;
      if (categoryFilter && complaint.category.code !== categoryFilter) return false;
      if (duplicatesOnly && !complaint.cluster) return false;
      if (query) {
        const haystack = `${complaint.title} ${complaint.description} #${complaint.id}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [complaints, statusFilter, categoryFilter, searchQuery, duplicatesOnly]);

  const countsByStatus = useMemo(() => {
    const counts: Record<ComplaintStatus, number> = {
      submitted: 0,
      under_review: 0,
      assigned: 0,
      in_progress: 0,
      resolved: 0,
    };
    complaints.forEach((c) => {
      counts[c.status] += 1;
    });
    return counts;
  }, [complaints]);

  const duplicateMetrics = useMemo(() => {
    const duplicates = complaints.filter((c) => c.cluster !== null);
    const heads = complaints.filter((c) => c.clusterMembers > 0);
    const linkedReports = duplicates.length + heads.length; // approximate for the loaded set
    return { duplicateReports: duplicates.length, clusterHeads: heads.length, linkedReports };
  }, [complaints]);

  /* ---- advancing the state machine ---------------------------------------- */
  const advanceComplaint = async (
    complaint: AdminComplaint,
    note: string
  ) => {
    const action = NEXT_ACTION[complaint.status];
    if (!action || advancingId !== null) return;

    setAdvancingId(complaint.id);
    setActionError(null);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-admin-id': adminUserId,
      };

      const response = await fetch(
        `${LIST_ENDPOINT}/${complaint.id}/advance`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            nextStatus: action.status,
            statusReason: note.trim() || null,
          }),
        }
      );
      const data = (await response.json().catch(() => null)) as {
        error?: string;
        complaint?: AdminComplaint;
      } | null;

      if (!response.ok) {
        const message =
          data?.error ??
          (response.status === 409
            ? 'Illegal state transition — the complaint has already moved on.'
            : `Advance failed (HTTP ${response.status}).`);
        setActionError({ id: complaint.id, message });
        return;
      }

      // Refresh so the DB trigger's audit entry + new status show up.
      setNoteOpenFor(null);
      setNoteText('');
      await fetchComplaints();
    } catch (error) {
      setActionError({
        id: complaint.id,
        message:
          error instanceof Error
            ? error.message
            : 'Network error — the status may not have changed. Retry.',
      });
    } finally {
      setAdvancingId(null);
    }
  };

  /* ---- render helpers ------------------------------------------------------ */
  const renderAdvanceControls = (complaint: AdminComplaint) => {
    const action = NEXT_ACTION[complaint.status];
    if (!action) {
      return (
        <span className="text-xs font-semibold text-emerald-600">
          ✓ Reached final state
        </span>
      );
    }
    const noteOpen = noteOpenFor === complaint.id;

    return (
      <div>
        {!noteOpen ? (
          <div className="flex items-center justify-end gap-2">
            {actionError?.id === complaint.id && (
              <p className="text-xs font-medium text-rose-600">
                {actionError.message}
              </p>
            )}
            <button
              type="button"
              onClick={() => {
                setNoteOpenFor(complaint.id);
                setNoteText(complaint.statusReason ?? '');
                setActionError(null);
              }}
              disabled={advancingId !== null}
              className="rounded-full bg-emerald-600 px-3.5 py-1.5 text-xs font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-40"
            >
              {action.label} →
            </button>
          </div>
        ) : (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-semibold text-slate-600">
              Move to{' '}
              <span className="text-emerald-700">
                “{STATUS_META[action.status].label}”
              </span>{' '}
              — add a note (optional, goes to the audit log):
            </p>
            <textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="e.g. Verified with the field officer; escalated to the PHE division."
              className="mt-2 w-full resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200"
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[11px] text-slate-400">
                {noteText.length}/500 · logged via status_logs
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setNoteOpenFor(null)}
                  disabled={advancingId === complaint.id}
                  className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => advanceComplaint(complaint, noteText)}
                  disabled={advancingId !== null}
                  className="rounded-full bg-emerald-600 px-3.5 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-40"
                >
                  {advancingId === complaint.id ? 'Updating…' : 'Confirm'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderEvidence = (complaint: AdminComplaint) => {
    if (!complaint.images || complaint.images.length === 0) {
      return (
        <span className="text-xs italic text-slate-400">No photos attached</span>
      );
    }
    return (
      <div className="flex flex-wrap gap-2">
        {complaint.images.map((image, index) => (
          <a
            key={`${complaint.id}-${index}`}
            href={image.url}
            target="_blank"
            rel="noreferrer"
            title={`Evidence ${index + 1}${image.size ? ` · ${formatBytes(image.size)}` : ''} — click to open`}
            className="group relative block h-16 w-16 overflow-hidden rounded-lg ring-1 ring-black/10 transition hover:ring-2 hover:ring-emerald-500"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={image.url}
              alt={`Evidence photo ${index + 1} for complaint #${complaint.id}`}
              className="h-full w-full object-cover transition group-hover:scale-105"
            />
          </a>
        ))}
      </div>
    );
  };

  const renderCard = (complaint: AdminComplaint) => (
    <div
      key={complaint.id}
      className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-slate-400">
              #{complaint.id}
            </span>
            <ClusterChip complaint={complaint} />
          </div>
          <h3 className="mt-1 text-sm font-bold text-slate-900">
            {complaint.title}
          </h3>
        </div>
        <StatusBadge status={complaint.status} />
      </div>

      <p className="line-clamp-3 text-sm leading-relaxed text-slate-600">
        {complaint.description}
      </p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500">
        <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600 ring-1 ring-slate-200">
          {complaint.category.label}
        </span>
        <ReporterLine complaint={complaint} />
        <LocationLine complaint={complaint} />
      </div>

      {renderEvidence(complaint)}

      <div className="mt-auto flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
        <span className="text-[11px] text-slate-400">
          Reported {formatDate(complaint.createdAt)}
        </span>
        {renderAdvanceControls(complaint)}
      </div>
    </div>
  );

  const renderTable = () => (
    <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full min-w-[900px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
            <th className="px-4 py-3 font-semibold">Complaint</th>
            <th className="px-4 py-3 font-semibold">Status</th>
            <th className="px-4 py-3 font-semibold">Category</th>
            <th className="px-4 py-3 font-semibold">Cluster</th>
            <th className="px-4 py-3 font-semibold">Reporter</th>
            <th className="px-4 py-3 font-semibold">Location</th>
            <th className="px-4 py-3 font-semibold">Evidence</th>
            <th className="px-4 py-3 text-right font-semibold">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {filteredComplaints.map((complaint) => (
            <tr key={complaint.id} className="align-top hover:bg-slate-50/60">
              <td className="px-4 py-3">
                <span className="text-xs font-semibold text-slate-400">
                  #{complaint.id}
                </span>
                <p className="mt-0.5 max-w-[260px] truncate font-semibold text-slate-900" title={complaint.title}>
                  {complaint.title}
                </p>
                <p className="mt-0.5 line-clamp-2 max-w-[260px] text-xs text-slate-500">
                  {complaint.description}
                </p>
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={complaint.status} />
              </td>
              <td className="px-4 py-3 text-xs font-medium text-slate-600">
                {complaint.category.label}
              </td>
              <td className="px-4 py-3">
                <ClusterChip complaint={complaint} />
              </td>
              <td className="px-4 py-3">
                <ReporterLine complaint={complaint} />
              </td>
              <td className="px-4 py-3">
                <LocationLine complaint={complaint} />
              </td>
              <td className="px-4 py-3">{renderEvidence(complaint)}</td>
              <td className="px-4 py-3 text-right">{renderAdvanceControls(complaint)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  /* ---- render ------------------------------------------------------------- */
  return (
    <div className="min-h-screen bg-slate-100">
      <main className="mx-auto w-full max-w-7xl px-4 py-6">
        {/* ---------- header ---------- */}
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-emerald-700">
              Government of Jharkhand · SIH 26043
            </p>
            <h1 className="mt-1 text-2xl font-bold text-slate-900">
              Complaint Resolution Queue
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              Showing {filteredComplaints.length} of {complaints.length} complaint
              {complaints.length === 1 ? '' : 's'} · auto-audited state machine
            </p>
          </div>
          <button
            type="button"
            onClick={fetchComplaints}
            disabled={loading}
            className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? 'Refreshing…' : '↻ Refresh'}
          </button>
        </header>

        {/* ---------- duplicate cluster metrics strip ---------- */}
        <section className="mt-4 grid gap-3 rounded-2xl border border-indigo-200 bg-gradient-to-r from-indigo-50 to-white p-4 sm:grid-cols-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-500">
              Duplicate reports in view
            </p>
            <p className="mt-0.5 text-2xl font-bold text-indigo-900">
              {duplicateMetrics.duplicateReports}
            </p>
            <p className="text-xs text-indigo-600">
              complaints linked to a parent via SBERT similarity
            </p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-500">
              Cluster heads
            </p>
            <p className="mt-0.5 text-2xl font-bold text-indigo-900">
              {duplicateMetrics.clusterHeads}
            </p>
            <p className="text-xs text-indigo-600">
              original reports with {duplicateMetrics.duplicateReports > 0 ? 'linked members' : 'no linked members yet'}
            </p>
          </div>
          <div className="flex flex-col justify-center">
            <p className="text-xs text-indigo-700">
              Use the <span className="font-semibold">“Duplicates only”</span>{' '}
              filter below to triage grouped reports at once — each card shows
              its similarity score against the parent report.
            </p>
            <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm font-medium text-indigo-900">
              <input
                type="checkbox"
                checked={duplicatesOnly}
                onChange={(e) => setDuplicatesOnly(e.target.checked)}
                className="h-4 w-4 rounded accent-indigo-600"
              />
              Duplicates only
            </label>
          </div>
        </section>

        {/* ---------- status tabs ---------- */}
        <nav className="mt-4 flex flex-wrap gap-2" aria-label="Filter by status">
          <button
            type="button"
            onClick={() => setStatusFilter('all')}
            className={`rounded-full px-3.5 py-1.5 text-xs font-semibold ring-1 transition ${
              statusFilter === 'all'
                ? 'bg-slate-900 text-white ring-slate-900'
                : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50'
            }`}
          >
            All · {complaints.length}
          </button>
          {STATUS_ORDER.map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => setStatusFilter(status)}
              className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold ring-1 transition ${
                statusFilter === status
                  ? 'bg-slate-900 text-white ring-slate-900'
                  : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${STATUS_META[status].dot}`} />
              {STATUS_META[status].label} · {countsByStatus[status]}
            </button>
          ))}
        </nav>

        {/* ---------- filter bar ---------- */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
              🔍
            </span>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by title or description…"
              className="w-full rounded-full border border-slate-300 bg-white py-2 pl-9 pr-4 text-sm text-slate-800 shadow-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200"
            />
          </div>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            aria-label="Filter by category"
            className="rounded-full border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm outline-none focus:border-emerald-500"
          >
            <option value="">All categories</option>
            {CATEGORY_OPTIONS.map((category) => (
              <option key={category.code} value={category.code}>
                {category.label}
              </option>
            ))}
          </select>
          <div className="flex rounded-full border border-slate-300 bg-white p-0.5 shadow-sm">
            {(['cards', 'table'] as ViewMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold capitalize transition ${
                  viewMode === mode
                    ? 'bg-emerald-600 text-white'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                {mode === 'cards' ? '▦ Cards' : '☰ Table'}
              </button>
            ))}
          </div>
        </div>

        {/* ---------- body ---------- */}
        {loading ? (
          <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-44 animate-pulse rounded-2xl border border-slate-200 bg-slate-200/70"
              />
            ))}
          </div>
        ) : loadError ? (
          <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-6 text-center">
            <p className="text-3xl">📡</p>
            <h2 className="mt-2 text-sm font-bold text-rose-800">
              Could not load the complaint queue
            </h2>
            <p className="mx-auto mt-1 max-w-lg text-sm text-rose-700">
              {loadError}
            </p>
            <button
              type="button"
              onClick={fetchComplaints}
              className="mt-4 rounded-full bg-rose-600 px-5 py-2 text-sm font-semibold text-white hover:bg-rose-700"
            >
              Retry
            </button>
          </div>
        ) : complaints.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
            <p className="text-4xl">🗂️</p>
            <h2 className="mt-2 text-sm font-bold text-slate-700">
              No complaints yet
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              New citizen reports will appear here once the intake route stores
              them.
            </p>
            <button
              type="button"
              onClick={fetchComplaints}
              className="mt-3 text-sm font-semibold text-emerald-700 underline underline-offset-2"
            >
              Refresh again
            </button>
          </div>
        ) : filteredComplaints.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
            <p className="text-4xl">🔍</p>
            <h2 className="mt-2 text-sm font-bold text-slate-700">
              No complaints match these filters
            </h2>
            <button
              type="button"
              onClick={() => {
                setStatusFilter('all');
                setCategoryFilter('');
                setSearchQuery('');
                setDuplicatesOnly(false);
              }}
              className="mt-3 text-sm font-semibold text-emerald-700 underline underline-offset-2"
            >
              Clear all filters
            </button>
          </div>
        ) : (
          <div className="mt-6">
            {viewMode === 'cards' ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {filteredComplaints.map(renderCard)}
              </div>
            ) : (
              renderTable()
            )}
          </div>
        )}
      </main>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Page — Suspense wrapper so useSearchParams can be used safely in Next.js
 * -------------------------------------------------------------------------- */

export default function AdminComplaintsPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen animate-pulse bg-slate-100" aria-busy="true" />
      }
    >
      <ComplaintQueue />
    </Suspense>
  );
}
