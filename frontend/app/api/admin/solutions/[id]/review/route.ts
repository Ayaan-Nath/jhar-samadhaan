import { NextRequest, NextResponse } from 'next/server';
import { getDbPool } from '../../../../../../lib/db';

/* ============================================================================
 * PATCH /api/admin/solutions/:id/review  (Module 7 — verification & loop closure)
 *
 * Lets a govt_admin review one prototype iteration and apply a decision:
 *   'approved'            -> prototype verified
 *   'revision_requested'  -> team must submit another iteration
 *   'rejected'            -> submission dismissed (with comment)
 *
 * A mandatory review comment (>= 10 chars) is captured on the row, plus
 * reviewer id + timestamp. The whole flow runs in ONE transaction:
 *
 *   1. Lock + validate the solution (must not already be 'approved').
 *   2. UPDATE solutions SET status, reviewed_by, reviewed_at, review_comment.
 *   3. Insert notifications for the TEAM LEAD and the ORIGINAL CITIZEN so the
 *      closed-loop email alerts fire (only for users who opted in).
 *   4. On 'approved', advance the linked complaint to 'resolved' — but ONLY
 *      when it is legally allowed by the linear state machine (status =
 *      'in_progress'): the fn_complaints_status_guard trigger validates the
 *      jump and writes the status_logs audit row automatically. Complaints
 *      still earlier in the workflow are left untouched (never force-jumped,
 *      preserving audit integrity).
 *
 * Request:
 *   header x-admin-id   govt_admin performing the review
 *   body   { decision, reviewComment }
 * ==========================================================================*/

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MIN_COMMENT_LENGTH = 10;
const DECISIONS = new Set(['approved', 'rejected', 'revision_requested']);

interface AdminRow {
  id: number;
  role: string;
}

interface SolutionContextRow {
  id: number;
  iteration: number;
  title: string;
  status: string;
  claim_id: number;
  complaint_id: number;
  team_lead_id: number;
  citizen_user_id: number;
  complaint_status: string;
}

interface SolutionUpdateRow {
  id: number;
  status: string;
  reviewed_at: Date;
  review_comment: string | null;
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  let pool;
  try {
    pool = getDbPool();
  } catch (error) {
    console.error('[PATCH review] DB not configured:', error);
    return NextResponse.json(
      { error: 'Database is not configured. Set DATABASE_URL first.' },
      { status: 500 }
    );
  }

  /* ---- path param ---------------------------------------------------------- */
  const { id } = await context.params;
  const solutionId = Number(id);
  if (!Number.isInteger(solutionId) || solutionId <= 0) {
    return NextResponse.json(
      { error: 'Solution id must be a positive integer.' },
      { status: 400 }
    );
  }

  /* ---- authorization -------------------------------------------------------- */
  const adminId = Number(request.headers.get('x-admin-id'));
  if (!Number.isInteger(adminId) || adminId <= 0) {
    return NextResponse.json(
      { error: 'Missing or invalid x-admin-id header. Authentication required.' },
      { status: 401 }
    );
  }

  /* ---- body ----------------------------------------------------------------- */
  let decision: string;
  let reviewComment: string;
  try {
    const body = (await request.json()) as {
      decision?: unknown;
      reviewComment?: unknown;
    };

    if (typeof body.decision !== 'string' || !DECISIONS.has(body.decision)) {
      return NextResponse.json(
        {
          error: `decision must be one of: ${[...DECISIONS].join(', ')}.`,
        },
        { status: 400 }
      );
    }
    decision = body.decision;

    if (typeof body.reviewComment !== 'string') {
      return NextResponse.json(
        { error: 'A review comment is required for every decision.' },
        { status: 400 }
      );
    }
    reviewComment = body.reviewComment.trim();
    if (reviewComment.length < MIN_COMMENT_LENGTH) {
      return NextResponse.json(
        {
          error: `Review comment must be at least ${MIN_COMMENT_LENGTH} characters (transparency mandate).`,
        },
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
    /* ---- verify the reviewer role ------------------------------------------- */
    const adminResult = await client.query<AdminRow>(
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
        { error: 'Only govt_admin accounts may review prototype submissions.' },
        { status: 403 }
      );
    }

    await client.query('BEGIN');

    /* ---- lock the solution + fetch its context (claim -> complaint) ---------- */
    const contextResult = await client.query<SolutionContextRow>(
      `SELECT
         s.id,
         s.iteration,
         s.title,
         s.status,
         cl.id            AS claim_id,
         c.id             AS complaint_id,
         cl.team_lead_id,
         c.user_id        AS citizen_user_id,
         c.status         AS complaint_status
      FROM solutions s
      JOIN claims cl     ON cl.id = s.claim_id
      JOIN complaints c  ON c.id = cl.complaint_id
      WHERE s.id = $1
      FOR UPDATE OF s`,
      [solutionId]
    );
    const solution = contextResult.rows[0];
    if (!solution) {
      await client.query('ROLLBACK');
      return NextResponse.json(
        { error: `Solution #${solutionId} was not found.` },
        { status: 404 }
      );
    }
    if (solution.status === 'approved') {
      await client.query('ROLLBACK');
      return NextResponse.json(
        {
          error: `Solution iteration #${solution.iteration} is already approved and cannot be re-reviewed.`,
        },
        { status: 409 }
      );
    }

    /* ---- 1) apply the decision on the solution row --------------------------- */
    const updateResult = await client.query<SolutionUpdateRow>(
      `UPDATE solutions
          SET status          = $1,
              reviewed_by     = $2,
              reviewed_at     = now(),
              review_comment  = $3
        WHERE id = $4
        RETURNING id, status, reviewed_at, review_comment`,
      [decision, adminId, reviewComment, solutionId]
    );
    const updated = updateResult.rows[0];

    const decisionLabel =
      decision === 'approved'
        ? 'approved'
        : decision === 'revision_requested'
          ? 'marked for revision'
          : 'rejected';

    /* ---- 2) closed-loop notifications (opt-in only) --------------------------- */
    const notifyInserted = { teamLead: false, citizen: false };

    const insertNotification = async (
      userId: number,
      complaintId: number,
      type: 'solution_review' | 'complaint_status',
      subject: string,
      body: string
    ) => {
      const allowed = await client.query<{ allow_email_alerts: boolean }>(
        `SELECT allow_email_alerts FROM users WHERE id = $1 AND is_active = TRUE`,
        [userId]
      );
      if (!allowed.rows[0]?.allow_email_alerts) return;
      await client.query(
        `INSERT INTO notifications (user_id, complaint_id, type, channel, subject, body)
         VALUES ($1, $2, $3, 'email', $4, $5)`,
        [userId, complaintId, type, subject, body]
      );
    };

    // Team lead always hears about their own submission review.
    if (decision !== 'approved') {
      await insertNotification(
        solution.team_lead_id,
        solution.complaint_id,
        'solution_review',
        `Your prototype iteration #${solution.iteration} was ${decisionLabel}`,
        `Solution "${solution.title}" (iteration #${solution.iteration}) for complaint #${solution.complaint_id} was ${decisionLabel}.\n\nReviewer note:\n${reviewComment}`
      );
      notifyInserted.teamLead = true;
    }

    // The original citizen follows the loop closure (approval -> resolved).
    if (decision === 'approved') {
      await insertNotification(
        solution.team_lead_id,
        solution.complaint_id,
        'solution_review',
        `Your prototype iteration #${solution.iteration} was approved 🎉`,
        `Solution "${solution.title}" (iteration #${solution.iteration}) for complaint #${solution.complaint_id} was approved.\n\nReviewer note:\n${reviewComment}`
      );
      notifyInserted.teamLead = true;

      await insertNotification(
        solution.citizen_user_id,
        solution.complaint_id,
        'complaint_status',
        'Your issue has been resolved 🎉',
        `A verified prototype has been approved for your report #${solution.complaint_id}. The complaint is now marked as resolved.\n\nReviewer note:\n${reviewComment}`
      );
      notifyInserted.citizen = true;
    } else {
      // Keep the citizen informed that resolution is progressing / needs work.
      await insertNotification(
        solution.citizen_user_id,
        solution.complaint_id,
        'solution_review',
        `Update on your report #${solution.complaint_id}`,
        `The prototype for your report was ${decisionLabel}. Your complaint remains open and tracked.\n\nReviewer note:\n${reviewComment}`
      );
      notifyInserted.citizen = true;
    }

    /* ---- 3) loop closure: approve -> advance complaint when legally allowed ----
     * Only an 'in_progress' complaint may move to 'resolved' per the strict
     * state machine; the DB trigger writes the status_logs audit entry. We
     * never force-jump earlier states, preserving the audit mandate. */
    let complaintAdvanced = false;
    if (decision === 'approved') {
      const advanceResult = await client.query(
        `UPDATE complaints
            SET status = 'resolved',
                updated_by = $1,
                status_reason = 'Prototype verified & approved (solution iteration #' || $2 || ' for complaint resolution)'
          WHERE id = $3 AND status = 'in_progress'
          RETURNING id`,
        [adminId, solution.iteration, solution.complaint_id]
      );
      complaintAdvanced = (advanceResult.rowCount ?? 0) > 0;
    }

    await client.query('COMMIT');

    return NextResponse.json(
      {
        solution: {
          id: updated.id,
          status: updated.status,
          reviewedAt: updated.reviewed_at.toISOString(),
          reviewComment: updated.review_comment,
        },
        notificationsSent: notifyInserted,
        complaintAdvanced,
        message:
          decision === 'approved'
            ? complaintAdvanced
              ? 'Prototype approved — complaint marked resolved and all parties notified.'
              : 'Prototype approved. Complaint will advance to resolved when the workflow reaches "in progress".'
            : `Iteration ${decisionLabel}. Team lead and citizen have been notified.`,
      },
      { status: 200 }
    );
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // connection may already be broken
    }
    console.error('[PATCH review] failed:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Review failed: ${error.message}`
            : 'Review failed. Please try again.',
      },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}
