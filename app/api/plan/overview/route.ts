import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import { loadRacePlanOverview } from "@/lib/racePlanOverview";

/**
 * GET /api/plan/overview
 * The backward race plan for the goal race ahead — one entry per week, with the sessions already
 * generated for it — plus the plan's warnings. `goal` is null when there is no upcoming goal race.
 */
export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json(await loadRacePlanOverview(auth.db, auth.userId));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
