// Server-side loader for the /plan screen: the backward race plan, the user's races and the sessions
// already generated for the plan's weeks. Read-only.

import type { Db } from "@/lib/supabase";
import { loadRaces } from "@/lib/races";
import { loadAthleteCalibration } from "@/lib/athlete/profile";
import { addDays, isoDate, parseIsoDate, toMonday } from "@/lib/planner/dates";
import { isRaceActivity, resolveRacePlanWeek } from "@/lib/planner/racePlanWeek";
import { RACE_PAIN_WARNING_MIN_SCORE } from "@/lib/planner/race";
import type { RaceKeySession, RacePhase } from "@/lib/planner/racePlan";

type ServiceClient = Db;

export interface PlanSessionDto {
  id: string;
  date: string;
  kind: string;
  label: string | null;
  minutes: number | null;
  km: number | null;
  completed: boolean;
  skipped: boolean;
  modality: string | null;
  indoor: boolean | null;
}

export interface PlanWeekDto {
  weekStart: string;
  weekEnd: string;
  weeksToRace: number;
  phase: RacePhase;
  targetKm: number;
  longRunMin: number;
  /** Km at marathon pace in the long run, 0 when none. */
  mpKm: number;
  keySession: RaceKeySession;
  raceIds: string[];
  raceNames: string[];
  isDeload: boolean;
  notes: string[];
  sessions: PlanSessionDto[];
}

export interface PlanOverview {
  today: string;
  currentWeekStart: string;
  goal: { id: string; name: string; date: string; distanceKm: number } | null;
  weeks: PlanWeekDto[];
  warnings: string[];
  baselineKm: number;
  peakKm: number;
}

export async function loadRacePlanOverview(db: ServiceClient, userId: string, now = new Date()): Promise<PlanOverview> {
  const today = parseIsoDate(isoDate(now));
  const currentWeek = toMonday(today);
  const empty: PlanOverview = {
    today: isoDate(today),
    currentWeekStart: isoDate(currentWeek),
    goal: null,
    weeks: [],
    warnings: [],
    baselineKm: 0,
    peakKm: 0,
  };

  const races = await loadRaces(db, userId);
  const { data: rows, error } = await db
    .from("garmin_activities")
    .select("start_time, duration_seconds, distance_meters, activity_type, event_type:raw_data->eventType->>typeKey")
    .eq("user_id", userId)
    .gte("start_time", addDays(today, -120).toISOString());
  if (error) throw new Error(error.message);
  const { data: flags } = await db
    .from("subjective_entries")
    .select("entry_date")
    .eq("user_id", userId)
    .gte("pain_score", RACE_PAIN_WARNING_MIN_SCORE)
    .gte("entry_date", isoDate(addDays(today, -42)));
  const { calibration } = await loadAthleteCalibration(db, userId);

  const activities = (rows ?? []).map((a) => {
    const startTime = new Date(a.start_time);
    const distanceKm = (a.distance_meters ?? 0) / 1000;
    return {
      startTime,
      distanceKm,
      durationMinutes: (a.duration_seconds ?? 0) / 60,
      activityType: a.activity_type,
      isRace: isRaceActivity({ startTime, distanceKm, eventType: (a as { event_type?: string | null }).event_type }, races),
    };
  });

  const resolved = resolveRacePlanWeek({
    races,
    weekStart: currentWeek,
    today,
    activities,
    flaggedDates: (flags ?? []).map((f) => parseIsoDate(f.entry_date)),
    easyPaceSecPerKm: calibration.easyPaceSecPerKm,
  });
  if (!resolved) return empty;

  const { plan, goal } = resolved;
  const firstWeek = plan.weeks[0]?.weekStart ?? currentWeek;
  const end = addDays(plan.weeks[plan.weeks.length - 1]?.weekStart ?? currentWeek, 7);
  const { data: sessionRows, error: sessionsError } = await db
    .from("planned_sessions")
    .select("id, planned_date, session_type, session_label, target_duration_minutes, target_distance_km, completed, skipped, modality, indoor")
    .eq("user_id", userId)
    .gte("planned_date", isoDate(firstWeek))
    .lt("planned_date", isoDate(end))
    .order("planned_date", { ascending: true });
  if (sessionsError) throw new Error(sessionsError.message);

  const names = new Map(races.map((r) => [r.id, r.name]));
  const weeks: PlanWeekDto[] = plan.weeks.map((w) => {
    const start = isoDate(w.weekStart);
    const stop = isoDate(addDays(w.weekStart, 7));
    return {
      weekStart: start,
      weekEnd: isoDate(addDays(w.weekStart, 6)),
      weeksToRace: w.weeksToRace,
      phase: w.phase,
      targetKm: w.targetKm,
      longRunMin: w.longRunMin,
      mpKm: w.longRunMpBlock ? w.longRunMpBlock.reps * w.longRunMpBlock.kmEach : 0,
      keySession: w.keySession,
      raceIds: w.raceIds,
      raceNames: w.raceIds.map((id) => names.get(id) ?? "Course"),
      isDeload: w.isDeload,
      notes: w.notes,
      sessions: (sessionRows ?? [])
        .filter((s) => s.planned_date >= start && s.planned_date < stop)
        .map((s) => ({
          id: s.id,
          date: s.planned_date,
          kind: s.session_type,
          label: s.session_label,
          minutes: s.target_duration_minutes,
          km: s.target_distance_km,
          completed: Boolean(s.completed),
          skipped: Boolean(s.skipped),
          modality: s.modality,
          indoor: s.indoor,
        })),
    };
  });

  return {
    ...empty,
    goal: { id: goal.id, name: goal.name, date: isoDate(goal.raceDate), distanceKm: goal.distanceKm },
    weeks,
    warnings: plan.warnings,
    baselineKm: plan.baselineKm,
    peakKm: plan.peakKm,
  };
}
