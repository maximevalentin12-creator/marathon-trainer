import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { loadRacePlanOverview } from "@/lib/racePlanOverview";

/**
 * GET /api/plan/overview?userId=<uuid>
 * The backward race plan for the goal race ahead — one entry per week, with the sessions already
 * generated for it — plus the plan's warnings. `goal` is null when there is no upcoming goal race.
 */
export async function GET(req: NextRequest) {
  const userId = new URL(req.url).searchParams.get("userId");
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });
  try {
    return NextResponse.json(await loadRacePlanOverview(createServiceClient(), userId));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
