import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { raiseHrMaxFromObserved } from "@/lib/athlete/profile";
import { matchGarminActivitiesForUser, reevaluateCompletedSessionsForUser } from "@/lib/garmin/matchSessions";

/**
 * POST /api/profile/rescore?userId=<uuid>
 * Re-applies the evaluation pipeline to the data already in the database —
 * no Garmin call: the observed-max rule, then matching of still-unlinked
 * activities, then re-scoring of every completed session against the current
 * zones and scoring rules. For after a migration or a scoring change.
 */
export async function POST(req: NextRequest) {
  const userId = new URL(req.url).searchParams.get("userId");
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  try {
    const hrMax = await raiseHrMaxFromObserved(createServiceClient(), userId);
    const matched = await matchGarminActivitiesForUser(userId);
    const reevaluated = await reevaluateCompletedSessionsForUser(userId);
    return NextResponse.json({ ok: true, hrMax, matched, reevaluated });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
