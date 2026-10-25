import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import { raiseHrMaxFromObserved } from "@/lib/athlete/profile";
import { matchGarminActivitiesForUser, reevaluateCompletedSessionsForUser } from "@/lib/garmin/matchSessions";

/**
 * POST /api/profile/rescore
 * Re-applies the evaluation pipeline to the data already in the database —
 * no Garmin call: the observed-max rule, then matching of still-unlinked
 * activities, then re-scoring of every completed session against the current
 * zones and scoring rules. For after a migration or a scoring change.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { userId, db } = auth;

  try {
    const hrMax = await raiseHrMaxFromObserved(db, userId);
    const matched = await matchGarminActivitiesForUser(db, userId);
    const reevaluated = await reevaluateCompletedSessionsForUser(db, userId);
    return NextResponse.json({ ok: true, hrMax, matched, reevaluated });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
