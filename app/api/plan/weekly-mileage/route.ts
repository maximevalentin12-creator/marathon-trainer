import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import { toMonday, isoDate, parseIsoDate, addDays, activityModality } from "@/lib/planner";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Only running sessions count towards mileage — non-impact cardio is excluded entirely. */
const RUNNING_MODALITY = "running";

/** Weeks averaged for the volume brake's baseline. */
const BASELINE_WEEKS = 4;
/** Above this ratio of this week's km to the baseline, the card shows a (neutral, informational) warning. */
const VOLUME_WARNING_RATIO = 1.3;

interface SessionRow {
  planned_date: string;
  completed: boolean | null;
  skipped: boolean | null;
  target_distance_km: number | null;
  garmin_activity_id: number | null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function isResolved(s: SessionRow): boolean {
  return !!s.completed || !!s.skipped;
}

/**
 * Actual km covered by a set of sessions: the distance of the Garmin activity
 * matched to each completed one (see lib/garmin/matchSessions.ts). Sessions
 * that are skipped, still pending, or completed without a matched activity
 * contribute nothing.
 */
function actualKm(sessions: SessionRow[], metersByActivityId: Map<number, number>): number {
  const meters = sessions.reduce((sum, s) => {
    if (!s.completed || s.garmin_activity_id == null) return sum;
    return sum + (metersByActivityId.get(s.garmin_activity_id) ?? 0);
  }, 0);
  return round1(meters / 1000);
}

/**
 * GET /api/plan/weekly-mileage?weekStart=<YYYY-MM-DD>
 *
 * Weekly running mileage for the dashboard card, plus a comparison against the
 * previous week. Running sessions only — `modality = 'non_impact'` rows are
 * excluded, as are rest days.
 *
 * Two display modes, decided by how far along the week is:
 *  - "estimated" — as long as at least one of the week's running sessions is
 *    neither completed nor skipped. Sums `planned_sessions.target_distance_km`,
 *    the duration→distance estimate the planner already computed at generation
 *    time (lib/planner/rules.ts); nothing is re-derived here. Quality sessions
 *    carry no such estimate (interval work is prescribed by duration), so they
 *    are counted in `sessionsWithoutEstimate` and add 0 km.
 *  - "actual" — once every running session of the week is resolved. Sums the
 *    matched Garmin activities of the completed ones.
 *  - "none" — the week has no running session planned at all.
 *
 * `deltaPercent` is always measured against the previous week's *actual* km, so
 * the comparison means the same thing in either mode. It is null when there is
 * nothing comparable: no sessions last week, 0 actual km last week, or no
 * running session this week.
 *
 * `volume` is the volume brake: this week's km (estimated or actual, as above)
 * over the average ACTUAL running km of the previous 4 weeks — every running
 * activity Garmin recorded, planned or not, treadmill included (the body
 * doesn't care whether a run was in the plan); a week with no run counts as 0.
 * `ratio` is null when that average is 0 or the week has no running session.
 * `warning` is set above 1.3. Informational only — the plan is never changed.
 *
 * `weekStart` defaults to the Monday of the current week and is expected to be
 * a Monday, matching GET /api/plan/week.
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { userId, db } = auth;
  const params = req.nextUrl.searchParams;
  const weekStartParam = params.get("weekStart");
  if (weekStartParam && !ISO_DATE_RE.test(weekStartParam)) {
    return NextResponse.json({ error: "weekStart must be in YYYY-MM-DD format." }, { status: 400 });
  }

  const weekStart = weekStartParam ? parseIsoDate(weekStartParam) : toMonday(new Date());
  if (Number.isNaN(weekStart.getTime())) {
    return NextResponse.json({ error: "weekStart is not a valid date." }, { status: 400 });
  }

  const weekStartIso = isoDate(weekStart);
  const prevWeekStartIso = isoDate(addDays(weekStart, -7));
  const weekEndIso = isoDate(addDays(weekStart, 7));

  // Both weeks in one round trip — ISO dates sort lexicographically, so the
  // rows split on weekStartIso below.
  const { data: sessions, error } = await db
    .from("planned_sessions")
    .select("planned_date, completed, skipped, target_distance_km, garmin_activity_id")
    .eq("user_id", userId)
    .eq("modality", RUNNING_MODALITY)
    .neq("session_type", "rest")
    .gte("planned_date", prevWeekStartIso)
    .lt("planned_date", weekEndIso);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (sessions ?? []) as SessionRow[];
  const current = rows.filter((s) => s.planned_date >= weekStartIso);
  const previous = rows.filter((s) => s.planned_date < weekStartIso);

  const activityIds = rows
    .filter((s) => s.completed)
    .map((s) => s.garmin_activity_id)
    .filter((id): id is number => id != null);

  const metersByActivityId = new Map<number, number>();
  if (activityIds.length > 0) {
    const { data: activities, error: activityError } = await db
      .from("garmin_activities")
      .select("garmin_activity_id, distance_meters")
      .eq("user_id", userId)
      .in("garmin_activity_id", activityIds);
    if (activityError) return NextResponse.json({ error: activityError.message }, { status: 500 });
    for (const a of activities ?? []) metersByActivityId.set(a.garmin_activity_id, a.distance_meters ?? 0);
  }

  const resolvedCount = current.filter(isResolved).length;
  const mode: "estimated" | "actual" | "none" =
    current.length === 0 ? "none" : resolvedCount === current.length ? "actual" : "estimated";

  const km =
    mode === "actual"
      ? actualKm(current, metersByActivityId)
      : mode === "estimated"
        ? round1(current.reduce((sum, s) => sum + (s.target_distance_km ?? 0), 0))
        : 0;

  const baselineStartIso = isoDate(addDays(weekStart, -7 * BASELINE_WEEKS));
  const { data: baselineActivities, error: baselineError } = await db
    .from("garmin_activities")
    .select("activity_type, distance_meters")
    .eq("user_id", userId)
    .gte("start_time", `${baselineStartIso}T00:00:00Z`)
    .lt("start_time", `${weekStartIso}T00:00:00Z`);
  if (baselineError) return NextResponse.json({ error: baselineError.message }, { status: 500 });
  const baselineMeters = (baselineActivities ?? [])
    .filter((a) => activityModality(a.activity_type) === "running")
    .reduce((sum, a) => sum + (a.distance_meters ?? 0), 0);
  const baselineAvgKm = round1(baselineMeters / 1000 / BASELINE_WEEKS);
  const volumeRatio = mode !== "none" && baselineAvgKm > 0 ? Math.round((km / baselineAvgKm) * 100) / 100 : null;

  const previousActualKm = actualKm(previous, metersByActivityId);
  const hasBaseline = previous.length > 0 && previousActualKm > 0;
  const deltaPercent =
    mode !== "none" && hasBaseline ? Math.round(((km - previousActualKm) / previousActualKm) * 100) : null;

  return NextResponse.json({
    weekStart: weekStartIso,
    mode,
    km,
    runningSessions: current.length,
    resolvedSessions: resolvedCount,
    sessionsWithoutEstimate: current.filter((s) => s.target_distance_km == null).length,
    previousWeek: {
      weekStart: prevWeekStartIso,
      actualKm: previousActualKm,
      hasSessions: previous.length > 0,
    },
    deltaPercent,
    volume: {
      baselineWeeks: BASELINE_WEEKS,
      baselineAvgKm,
      ratio: volumeRatio,
      warning: volumeRatio !== null && volumeRatio > VOLUME_WARNING_RATIO,
    },
  });
}
