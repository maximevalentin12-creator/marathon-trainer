import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import {
  toMonday,
  isoDate,
  parseIsoDate,
  addDays,
  activityModality,
  isIndoorActivity,
  type NonImpactMachine,
} from "@/lib/planner";
import type { HistoryModality, HistoryResponse, HistoryRow, HistoryStatus, HistoryWeek } from "@/lib/history/types";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_WEEKS = 6;
const MAX_WEEKS = 26;

const KIND_LABEL: Record<string, string> = {
  easy: "Facile",
  long: "Longue facile",
  threshold: "Qualité",
  vo2max: "Qualité",
  race: "Course",
};

interface PlannedRow {
  id: string;
  planned_date: string;
  session_type: string;
  session_label: string | null;
  modality: string | null;
  machine: NonImpactMachine | null;
  indoor: boolean | null;
  target_duration_minutes: number | null;
  target_distance_km: number | null;
  completed: boolean | null;
  skipped: boolean | null;
  garmin_activity_id: number | null;
  completion_score: number | null;
  completion_note: string | null;
  completion_analysis: string[] | null;
  shoe_id: string | null;
}

interface ActivityRow {
  garmin_activity_id: number;
  activity_type: string | null;
  start_time: string;
  duration_seconds: number | null;
  distance_meters: number | null;
  avg_pace_sec_per_km: number | null;
  avg_heart_rate: number | null;
}

const PLANNED_COLUMNS =
  "id, planned_date, session_type, session_label, modality, machine, indoor, target_duration_minutes, target_distance_km, completed, skipped, garmin_activity_id, completion_score, completion_note, completion_analysis, shoe_id";
const ACTIVITY_COLUMNS =
  "garmin_activity_id, activity_type, start_time, duration_seconds, distance_meters, avg_pace_sec_per_km, avg_heart_rate";

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function kmOf(meters: number | null): number | null {
  return meters != null ? round1(meters / 1000) : null;
}

function actualOf(a: ActivityRow): NonNullable<HistoryRow["actual"]> {
  return {
    durationMinutes: a.duration_seconds != null ? Math.round(a.duration_seconds / 60) : null,
    durationSeconds: a.duration_seconds,
    distanceKm: kmOf(a.distance_meters),
    avgPaceSecPerKm: a.avg_pace_sec_per_km,
    avgHeartRate: a.avg_heart_rate,
  };
}

/** French label for an off-plan Garmin activity, from its activityType.typeKey. */
function offPlanLabel(activityType: string | null): string {
  const v = (activityType ?? "").toLowerCase();
  if (v === "treadmill_running") return "Course sur tapis";
  if (v.includes("trail")) return "Trail";
  if (v.includes("running")) return "Course";
  if (v.includes("cycling")) return "Vélo";
  if (v.includes("elliptical")) return "Elliptique";
  return activityType ? activityType.replace(/_/g, " ") : "Activité";
}

/** Activity start → UTC calendar date, the app-wide convention (see lib/planner/dates.ts). */
function activityDate(a: ActivityRow): string {
  return isoDate(new Date(a.start_time));
}

/**
 * GET /api/history?before=<YYYY-MM-DD>&weeks=<n>
 *
 * One page of the training history for /historique, newest week first.
 * Covers the `weeks` weeks (default 6, max 26) ending just before `before` —
 * a Monday, exclusive; defaults to the Monday after the current week, so the
 * first page includes the week in progress.
 *
 * Rows per week:
 *  - Planned (non-rest) sessions, running and non-impact, that are completed,
 *    skipped, or dated before today and still unresolved ("non appariée").
 *    Upcoming sessions stay in WeeklyPlanCard only.
 *  - Garmin activities in the window that no planned session links to
 *    ("hors plan") — otherwise a run done outside the plan would vanish from
 *    the user's history.
 *
 * Weeks with no rows are omitted, and `nextBefore` skips over empty stretches
 * straight to the next week that has data (null when there is none).
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { userId, db } = auth;
  const params = req.nextUrl.searchParams;
  const beforeParam = params.get("before");
  const weeksParam = params.get("weeks");
  if (beforeParam && !ISO_DATE_RE.test(beforeParam)) {
    return NextResponse.json({ error: "before must be in YYYY-MM-DD format." }, { status: 400 });
  }
  const weeks = weeksParam ? Number(weeksParam) : DEFAULT_WEEKS;
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > MAX_WEEKS) {
    return NextResponse.json({ error: `weeks must be an integer between 1 and ${MAX_WEEKS}.` }, { status: 400 });
  }

  const today = new Date();
  const todayIso = isoDate(today);
  const before = beforeParam ? toMonday(parseIsoDate(beforeParam)) : addDays(toMonday(today), 7);
  if (Number.isNaN(before.getTime())) {
    return NextResponse.json({ error: "before is not a valid date." }, { status: 400 });
  }
  const rangeStart = addDays(before, -7 * weeks);
  const rangeStartIso = isoDate(rangeStart);
  const rangeEndIso = isoDate(before);

  const [plannedRes, activitiesRes] = await Promise.all([
    db
      .from("planned_sessions")
      .select(PLANNED_COLUMNS)
      .eq("user_id", userId)
      .neq("session_type", "rest")
      .gte("planned_date", rangeStartIso)
      .lt("planned_date", rangeEndIso),
    db
      .from("garmin_activities")
      .select(ACTIVITY_COLUMNS)
      .eq("user_id", userId)
      .gte("start_time", rangeStart.toISOString())
      .lt("start_time", before.toISOString()),
  ]);
  if (plannedRes.error) return NextResponse.json({ error: plannedRes.error.message }, { status: 500 });
  if (activitiesRes.error) return NextResponse.json({ error: activitiesRes.error.message }, { status: 500 });

  const planned = ((plannedRes.data ?? []) as PlannedRow[]).filter(
    (s) => s.completed || s.skipped || s.planned_date < todayIso
  );
  const windowActivities = (activitiesRes.data ?? []) as ActivityRow[];

  const activityById = new Map<number, ActivityRow>(windowActivities.map((a) => [a.garmin_activity_id, a]));

  // Matching allows ±1 day, so a session near the window's edge can link to an
  // activity just outside it — fetch those separately.
  const missingLinkedIds = planned
    .map((s) => s.garmin_activity_id)
    .filter((id): id is number => id != null && !activityById.has(id));

  const windowActivityIds = windowActivities.map((a) => a.garmin_activity_id);

  const [missingRes, linkedRes, shoeRes] = await Promise.all([
    missingLinkedIds.length > 0
      ? db.from("garmin_activities").select(ACTIVITY_COLUMNS).eq("user_id", userId).in("garmin_activity_id", missingLinkedIds)
      : Promise.resolve({ data: [] as ActivityRow[], error: null }),
    // Which window activities are linked to *any* planned session — including
    // ones outside the window, or upcoming ones filtered out above.
    windowActivityIds.length > 0
      ? db
          .from("planned_sessions")
          .select("garmin_activity_id")
          .eq("user_id", userId)
          .in("garmin_activity_id", windowActivityIds)
      : Promise.resolve({ data: [] as { garmin_activity_id: number | null }[], error: null }),
    (() => {
      const shoeIds = Array.from(new Set(planned.map((s) => s.shoe_id).filter((id): id is string => id != null)));
      return shoeIds.length > 0
        ? db.from("shoes").select("id, name").eq("user_id", userId).in("id", shoeIds)
        : Promise.resolve({ data: [] as { id: string; name: string }[], error: null });
    })(),
  ]);
  if (missingRes.error) return NextResponse.json({ error: missingRes.error.message }, { status: 500 });
  if (linkedRes.error) return NextResponse.json({ error: linkedRes.error.message }, { status: 500 });
  if (shoeRes.error) return NextResponse.json({ error: shoeRes.error.message }, { status: 500 });

  for (const a of (missingRes.data ?? []) as ActivityRow[]) activityById.set(a.garmin_activity_id, a);
  const linkedIds = new Set(
    ((linkedRes.data ?? []) as { garmin_activity_id: number | null }[])
      .map((r) => r.garmin_activity_id)
      .filter((id): id is number => id != null)
  );
  const shoeById = new Map(((shoeRes.data ?? []) as { id: string; name: string }[]).map((s) => [s.id, s]));

  // ─── Build rows ───────────────────────────────────────────────────────────

  const rows: HistoryRow[] = [];

  for (const s of planned) {
    const activity = s.garmin_activity_id != null ? activityById.get(s.garmin_activity_id) : undefined;
    const status: HistoryStatus = s.completed ? "completed" : s.skipped ? "skipped" : "unmatched";
    const shoe = s.shoe_id ? shoeById.get(s.shoe_id) : undefined;
    rows.push({
      id: s.id,
      date: s.planned_date,
      label: s.session_label ?? KIND_LABEL[s.session_type] ?? s.session_type,
      modality: s.modality === "non_impact" ? "non_impact" : "running",
      machine: s.machine,
      indoor: s.indoor ?? false,
      status,
      isRace: s.session_type === "race",
      planned: { durationMinutes: s.target_duration_minutes, distanceKm: s.target_distance_km },
      actual: s.completed && activity ? actualOf(activity) : null,
      completionScore: s.completion_score,
      completionNote: s.completion_note,
      completionAnalysis: s.completion_analysis,
      shoe: shoe ? { id: shoe.id, name: shoe.name } : null,
    });
  }

  for (const a of windowActivities) {
    if (linkedIds.has(a.garmin_activity_id)) continue;
    const modality: HistoryModality = activityModality(a.activity_type) ?? "other";
    rows.push({
      id: `garmin-${a.garmin_activity_id}`,
      date: activityDate(a),
      label: offPlanLabel(a.activity_type),
      modality,
      machine: null,
      indoor: isIndoorActivity(a.activity_type),
      status: "off_plan",
      isRace: false,
      planned: null,
      actual: actualOf(a),
      completionScore: null,
      completionNote: null,
      completionAnalysis: null,
      shoe: null,
    });
  }

  // ─── Group by week ────────────────────────────────────────────────────────

  const byWeek = new Map<string, HistoryRow[]>();
  for (const r of rows) {
    const wk = isoDate(toMonday(parseIsoDate(r.date)));
    const list = byWeek.get(wk);
    if (list) list.push(r);
    else byWeek.set(wk, [r]);
  }

  const weeksOut: HistoryWeek[] = Array.from(byWeek.entries())
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([weekStart, weekRows]) => {
      weekRows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      const plannedRows = weekRows.filter((r) => r.status !== "off_plan");
      const offPlanRows = weekRows.filter((r) => r.status === "off_plan");
      const sumKm = (list: HistoryRow[]) =>
        round1(list.reduce((sum, r) => sum + (r.actual?.distanceKm ?? 0), 0));
      return {
        weekStart,
        runningKm: sumKm(plannedRows.filter((r) => r.modality === "running" && r.status === "completed")),
        offPlanRunningKm: sumKm(offPlanRows.filter((r) => r.modality === "running")),
        plannedCount: plannedRows.length,
        completedCount: plannedRows.filter((r) => r.status === "completed").length,
        offPlanCount: offPlanRows.length,
        rows: weekRows,
      };
    });

  // ─── Next page cursor ─────────────────────────────────────────────────────
  // The most recent data point older than this window, so the next page
  // starts at its week instead of paging through empty weeks.

  const [olderPlanned, olderActivity] = await Promise.all([
    db
      .from("planned_sessions")
      .select("planned_date")
      .eq("user_id", userId)
      .neq("session_type", "rest")
      .lt("planned_date", rangeStartIso)
      .order("planned_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
    db
      .from("garmin_activities")
      .select("start_time")
      .eq("user_id", userId)
      .lt("start_time", rangeStart.toISOString())
      .order("start_time", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (olderPlanned.error) return NextResponse.json({ error: olderPlanned.error.message }, { status: 500 });
  if (olderActivity.error) return NextResponse.json({ error: olderActivity.error.message }, { status: 500 });

  const olderDates = [
    olderPlanned.data?.planned_date as string | undefined,
    olderActivity.data ? isoDate(new Date(olderActivity.data.start_time as string)) : undefined,
  ].filter((d): d is string => d != null);
  const latestOlder = olderDates.sort()[olderDates.length - 1];
  const nextBefore = latestOlder ? isoDate(addDays(toMonday(parseIsoDate(latestOlder)), 7)) : null;

  const response: HistoryResponse = { weeks: weeksOut, nextBefore };
  return NextResponse.json(response);
}
