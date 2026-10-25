import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import {
  toMonday,
  isoDate,
  parseIsoDate,
  dayCodeToOffset,
  isDayCode,
  isNonImpactMachine,
  type DayCode,
  type NonImpactMachine,
} from "@/lib/planner";
import { regenerateWeekSessions, attachActualActivities } from "@/lib/planner/generateWeek";
import { loadAthleteZones } from "@/lib/athlete/profile";
import { attachRacePainWarnings } from "@/lib/races";

const ALL_DAYS: DayCode[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/**
 * GET /api/plan/week?userId=<uuid>&weekStart=<YYYY-MM-DD>
 * Returns the weekly setup (if any) and generated sessions for that week.
 * weekStart defaults to the Monday of the current week.
 */
export async function GET(req: NextRequest) {
  const params = new URL(req.url).searchParams;
  const userId = params.get("userId");
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const weekStart = params.get("weekStart") ? parseIsoDate(params.get("weekStart")!) : toMonday(new Date());
  const weekStartIso = isoDate(weekStart);
  const weekEndIso = isoDate(new Date(weekStart.getTime() + 7 * 86_400_000));

  const db = createServiceClient();

  const [{ data: setup }, { data: sessions, error: sessionsError }, { data: state }, zones] = await Promise.all([
    db
      .from("weekly_setups")
      .select("runs_per_week, indoor_runs, non_impact_sessions, non_impact_machines, available_days")
      .eq("user_id", userId)
      .eq("week_start", weekStartIso)
      .maybeSingle(),
    db
      .from("planned_sessions")
      .select("*")
      .eq("user_id", userId)
      .gte("planned_date", weekStartIso)
      .lt("planned_date", weekEndIso)
      .order("planned_date", { ascending: true }),
    db.from("progression_state").select("suggested_runs_per_week").eq("user_id", userId).maybeSingle(),
    loadAthleteZones(db, userId),
  ]);

  if (sessionsError) return NextResponse.json({ error: sessionsError.message }, { status: 500 });

  // Enrich completed sessions with the matched Garmin activity's actual numbers.
  const enrichedSessions = await attachRacePainWarnings(
    db,
    userId,
    await attachActualActivities(db, userId, sessions ?? [])
  );

  return NextResponse.json({
    weekStart: weekStartIso,
    setup: setup
      ? {
          runsPerWeek: setup.runs_per_week,
          indoorRuns: setup.indoor_runs,
          nonImpactSessions: setup.non_impact_sessions ?? 0,
          nonImpactMachines: (setup.non_impact_machines ?? []) as NonImpactMachine[],
          availableDays: (setup.available_days ?? ALL_DAYS) as DayCode[],
        }
      : null,
    suggestedRunsPerWeek: state?.suggested_runs_per_week ?? 2,
    zones,
    sessions: enrichedSessions,
  });
}

/**
 * POST /api/plan/week
 * Body: { userId, weekStart?: "YYYY-MM-DD", runsPerWeek: number, indoorRuns: number,
 *         nonImpactSessions?: number, nonImpactMachines?: NonImpactMachine[], availableDays?: DayCode[] }
 *
 * Records the weekly setup choice, runs the progression engine if this week
 * crosses a block boundary, and (re)generates the week's sessions. Completed
 * and skipped sessions, and unresolved ones dated before today, are never
 * deleted or modified: only unresolved sessions from today on are replaced,
 * and the remainder is planned around what's kept (see
 * lib/planner/generateWeek.ts). Returns the whole week. Manual day overrides
 * on replaced sessions are carried forward.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const {
    userId,
    weekStart: weekStartStr,
    runsPerWeek,
    indoorRuns,
    nonImpactSessions: nonImpactSessionsRaw,
    nonImpactMachines: nonImpactMachinesBody,
    availableDays: availableDaysBody,
  } = body as {
    userId: string;
    weekStart?: string;
    runsPerWeek: number;
    indoorRuns: number;
    nonImpactSessions?: number;
    nonImpactMachines?: unknown;
    availableDays?: unknown;
  };

  const nonImpactSessions = nonImpactSessionsRaw ?? 0;

  if (!userId) return NextResponse.json({ error: "userId is required." }, { status: 400 });
  if (!Number.isInteger(runsPerWeek) || runsPerWeek < 3 || runsPerWeek > 5) {
    return NextResponse.json({ error: "runsPerWeek must be an integer between 3 and 5." }, { status: 400 });
  }
  if (!Number.isInteger(nonImpactSessions) || nonImpactSessions < 0 || nonImpactSessions > 4) {
    return NextResponse.json({ error: "nonImpactSessions must be an integer between 0 and 4." }, { status: 400 });
  }
  const totalSessions = runsPerWeek + nonImpactSessions;
  if (totalSessions < 1 || totalSessions > 7) {
    return NextResponse.json(
      { error: "runsPerWeek + nonImpactSessions (the week's total) must be between 1 and 7." },
      { status: 400 }
    );
  }
  if (typeof indoorRuns !== "number" || indoorRuns < 0 || indoorRuns > runsPerWeek) {
    return NextResponse.json({ error: "indoorRuns must be between 0 and runsPerWeek." }, { status: 400 });
  }

  const nonImpactMachines: NonImpactMachine[] =
    Array.isArray(nonImpactMachinesBody) && nonImpactMachinesBody.length > 0
      ? Array.from(new Set(nonImpactMachinesBody.filter(isNonImpactMachine)))
      : [];
  if (Array.isArray(nonImpactMachinesBody) && nonImpactMachinesBody.some((m) => !isNonImpactMachine(m))) {
    return NextResponse.json(
      { error: "nonImpactMachines must only contain bike/assault_bike/elliptical." },
      { status: 400 }
    );
  }
  if (nonImpactSessions > 0 && nonImpactMachines.length === 0) {
    return NextResponse.json(
      { error: "nonImpactMachines must list at least one machine when nonImpactSessions > 0." },
      { status: 400 }
    );
  }

  const availableDayCodes: DayCode[] =
    Array.isArray(availableDaysBody) && availableDaysBody.length > 0
      ? Array.from(new Set(availableDaysBody.filter(isDayCode)))
      : ALL_DAYS;

  if (Array.isArray(availableDaysBody) && availableDaysBody.some((d) => !isDayCode(d))) {
    return NextResponse.json({ error: "availableDays must only contain mon/tue/wed/thu/fri/sat/sun." }, { status: 400 });
  }
  if (availableDayCodes.length < totalSessions) {
    return NextResponse.json(
      { error: "availableDays must include at least as many days as the week's total session count." },
      { status: 400 }
    );
  }

  const weekStart = weekStartStr ? parseIsoDate(weekStartStr) : toMonday(new Date());
  const weekStartIso = isoDate(weekStart);

  const db = createServiceClient();

  // Record the weekly setup choice — the user's choice always wins over any suggestion.
  const { error: setupError } = await db.from("weekly_setups").upsert(
    {
      user_id: userId,
      week_start: weekStartIso,
      runs_per_week: runsPerWeek,
      indoor_runs: indoorRuns,
      non_impact_sessions: nonImpactSessions,
      non_impact_machines: nonImpactMachines,
      available_days: availableDayCodes,
    },
    { onConflict: "user_id,week_start" }
  );
  if (setupError) return NextResponse.json({ error: setupError.message }, { status: 500 });

  const result = await regenerateWeekSessions({
    userId,
    weekStart,
    runsPerWeek,
    indoorRuns,
    nonImpactSessions,
    nonImpactMachines,
    availableDays: availableDayCodes.map(dayCodeToOffset),
  });

  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });

  return NextResponse.json(result);
}
