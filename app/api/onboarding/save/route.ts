import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import { toMonday, isoDate } from "@/lib/planner";

/** Parse "MM:SS" or "H:MM:SS" → total seconds, null if blank or invalid. */
function parseTime(s: string | null | undefined): number | null {
  if (!s?.trim()) return null;
  const parts = s.trim().split(":").map(Number);
  if (parts.some((n) => isNaN(n) || n < 0)) return null;
  if (parts.length === 2) return parts[1] < 60 ? parts[0] * 60 + parts[1] : null;
  if (parts.length === 3)
    return parts[1] < 60 && parts[2] < 60
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : null;
  return null;
}

/**
 * POST /api/onboarding/save
 * Body: { raceDate?, runsPerWeek, pb5k, pb10k, pbHalf, pbMarathon,
 *         injuryHistory, currentWeeklyKm }
 * Updates the users row with all onboarding answers. The app is
 * continuous/quarterly, not race-anchored, so raceDate is optional context only.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { userId, db } = auth;
  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid body." }, { status: 400 });
  }

  const {
    raceDate,
    runsPerWeek = 2,
    pb5k,
    pb10k,
    pbHalf,
    pbMarathon,
    injuryHistory,
    currentWeeklyKm,
  } = body as {
    raceDate?: string | null;
    runsPerWeek: 1 | 2 | 3;
    pb5k?: string;
    pb10k?: string;
    pbHalf?: string;
    pbMarathon?: string;
    injuryHistory?: string;
    currentWeeklyKm?: number;
  };
  if (![1, 2, 3].includes(runsPerWeek)) {
    return NextResponse.json({ error: "runsPerWeek must be 1, 2, or 3." }, { status: 400 });
  }

  const { error } = await db
    .from("users")
    .update({
      race_date: raceDate || null,
      runs_per_week: runsPerWeek,
      pb_5k_seconds: parseTime(pb5k),
      pb_10k_seconds: parseTime(pb10k),
      pb_half_seconds: parseTime(pbHalf),
      pb_marathon_seconds: parseTime(pbMarathon),
      injury_history: injuryHistory?.trim() || null,
      current_weekly_km: currentWeeklyKm ?? 30,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Seed progression state on first save only — re-running onboarding shouldn't
  // reset progress already made.
  const { data: existingState } = await db
    .from("progression_state")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (!existingState) {
    const monday = isoDate(toMonday(new Date()));
    const { error: stateError } = await db.from("progression_state").insert({
      user_id: userId,
      cycle_start_date: monday,
      phase: "base",
      block_start_date: monday,
      quality_level: 0,
      suggested_runs_per_week: runsPerWeek,
      last_change_applied: null,
    });
    if (stateError) {
      return NextResponse.json({ error: stateError.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}
