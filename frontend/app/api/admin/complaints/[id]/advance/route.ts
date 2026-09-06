import { NextRequest, NextResponse } from 'next/server';
import { getDbPool } from '../../../../../../lib/db';

/* ============================================================================
 * POST /api/admin/complaints/:id/advance
 *
 * Advances a complaint one step through the workflow state machine:
 *   Submitted -> Under Review -> Assigned -> In Progress -> Resolved
 *
 * The linearity check and the status_logs audit insert are intentionally NOT
 * re-implemented here — the PostgreSQL trigger fn_complaints_status_guard on
 * the complaints table performs both atomically whenever `status` is updated:
 * an illegal jump raises an exception (SQLSTATE P0001) which we surface as a
 * 409 Conflict; legal updates auto-insert the audit row with
 * changed_by = updated_by.
 *
 * Request:
 *   header  x-admin-id   numeric id of the govt_admin performing the action
 *   body    { nextStatus: ComplaintStatus, statusReason?: string }
 *
 * Responses:
 *   200  { complaint: { id, status, updatedAt, statusReason } }
 *   400  invalid body / id
 *   401  missing or unknown admin
 *   403  authenticated user is not a govt_admin
 *   404  complaint not found
 *   409  illegal state transition (rejected by the DB trigger)
 * ==========================================================================*/

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_STATUSES = new Set([
  'submitted',
  'under_review',
  'assigned',
  'in_progress',
  'resolved',
]);
const MAX_REASON_LENGTH = 500;

interface StatusRow {
  id: number;
  status: string;
  updated_at: Date;
  status_reason: string | null;
}

interface AdminRow {
  id: number;
  role: string;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  let pool;
  try {
    pool = getDbPool();
  } catch (error) {
    console.error('[POST advance] DB not configured:', error);
    return NextResponse.json(
      { error: 'Database is not configured. Set DATABASE_URL first.' },
      { status: 500 }
    );
  }

  /* ---- path param -------------------------------------------------------- */
  const { id } = await context.params;
  const complaintId = Number(id);
  if (!Number.isInteger(complaintId) || complaintId <= 0) {
    return NextResponse.json(
      { error: 'Complaint id must be a positive integer.' },
      { status: 400 }
    );
  }

  /* ---- authorization: x-admin-id must resolve to an active govt_admin ---- */
  const adminId = Number(request.headers.get('x-admin-id'));
  if (!Number.isInteger(adminId) || adminId <= 0) {
    return NextResponse.json(
      { error: 'Missing or invalid x-admin-id header. Authentication required.' },
      { status: 401 }
    );
  }

  /* ---- body -------------------------------------------------------------- */
  let nextStatus: string;
  let statusReason: string | null = null;
  try {
    const body = (await request.json()) as {
      nextStatus?: unknown;
      statusReason?: unknown;
    };

    if (typeof body.nextStatus !== 'string' || !VALID_STATUSES.has(body.nextStatus)) {
      return NextResponse.json(
        {
          error: `nextStatus must be one of: ${[...VALID_STATUSES].join(', ')}.`,
        },
        { status: 400 }
      );
    }
    nextStatus = body.nextStatus;

    if (body.statusReason !== undefined && body.statusReason !== null) {
      if (typeof body.statusReason !== 'string') {
        return NextResponse.json(
          { error: 'statusReason must be a string when provided.' },
          { status: 400 }
        );
      }
      const trimmed = body.statusReason.trim();
      if (trimmed.length > MAX_REASON_LENGTH) {
        return NextResponse.json(
          { error: `statusReason must be at most ${MAX_REASON_LENGTH} characters.` },
          { status: 400 }
        );
      }
      statusReason = trimmed || null;
    }
  } catch {
    return NextResponse.json(
      { error: 'Request body must be valid JSON.' },
      { status: 400 }
    );
  }

  try {
    /* ---- verify the admin role ------------------------------------------- */
    const adminResult = await pool.query<AdminRow>(
      `SELECT id, role FROM users WHERE id = $1 AND is_active = TRUE LIMIT 1`,
      [adminId]
    );
    const admin = adminResult.rows[0];
    if (!admin) {
      return NextResponse.json(
        { error: 'Unknown or deactivated admin account.' },
        { status: 401 }
      );
    }
    if (admin.role !== 'govt_admin') {
      return NextResponse.json(
        { error: 'Only govt_admin accounts may advance complaint statuses.' },
        { status: 403 }
      );
    }

    /* ---- perform the state-machine update ---------------------------------
     * The DB trigger validates that status -> nextStatus is a legal linear
     * transition and inserts the status_logs audit row (changed_by = adminId
     * via NEW.updated_by). Illegal transitions raise here -> caught below. */
    const updateResult = await pool.query<StatusRow>(
      `UPDATE complaints
          SET status        = $1,
              updated_by    = $2,
              status_reason = $3
        WHERE id = $4
        RETURNING id, status, status_reason, updated_at`,
      [nextStatus, adminId, statusReason, complaintId]
    );

    const complaint = updateResult.rows[0];
    if (!complaint) {
      return NextResponse.json(
        { error: `Complaint #${complaintId} was not found.` },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        complaint: {
          id: complaint.id,
          status: complaint.status,
          statusReason: complaint.status_reason,
          updatedAt: complaint.updated_at.toISOString(),
        },
      },
      { status: 200 }
    );
  } catch (error) {
    /* ---- surface DB-level transition violations as 409 -------------------- */
    const dbError = error as { code?: string; message?: string };
    const isTransitionViolation =
      dbError.code === 'P0001' || // plpgsql RAISE EXCEPTION
      (typeof dbError.message === 'string' &&
        dbError.message.includes('Illegal complaint status transition'));

    if (isTransitionViolation) {
      return NextResponse.json(
        {
          error:
            dbError.message ??
            'Illegal state transition — complaints must advance one step at a time.',
        },
        { status: 409 }
      );
    }

    console.error('[POST advance] update failed:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Failed to advance complaint status: ${error.message}`
            : 'Failed to advance complaint status.',
      },
      { status: 500 }
    );
  }
}
