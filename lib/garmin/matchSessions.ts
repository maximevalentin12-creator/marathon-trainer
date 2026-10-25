import type { Db } from "@/lib/supabase";
import type { HeartRateZones, Modality } from "@/lib/planner";
import { loadAthleteZones } from "@/lib/athlete/profile";
import {
  matchActivitiesToSessions,
  evaluateCompletion,
  dynamicsBaselineAt,
  indoorMismatchOf,
  isIndoorActivity,
  type CandidateActivity,
  type CandidateSession,
  type CompletionSessionType,
  type CompletionEvaluation,
  type ActivityLap,
  type PrescribedStep,
  type DynamicsSample,
  type IndoorMismatch,
} from "@/lib/planner/completion";

type ServiceClient = Db;

interface SessionEvalDetails {
  session_type: string;
  target_duration_minutes: number | null;
  target_pace_sec_per_km: number | null;
  variant: string | null;
  indoor: boolean | null;
  modality: string | null;
  steps: PrescribedStep[] | null;
}

interface ActivityEvalDetails {
  start_time: string;
  activity_type: string | null;
  duration_seconds: number | null;
  avg_pace_sec_per_km: number | null;
  avg_heart_rate: number | null;
  max_heart_rate: number | null;
  avg_cadence: number | null;
  avg_ground_contact_ms: number | null;
  avg_vertical_oscillation: number | null;
  aerobic_te: number | null;
  total_ascent_m: number | null;
  gap_pace_sec_per_km: number | null;
  laps: ActivityLap[] | null;
}

/** What scoring needs about the athlete beyond the two rows: zones, and runs for the dynamics baseline. */
interface EvalContext {
  zones: HeartRateZones;
  dynamicsSamples: DynamicsSample[];
}

async function loadEvalContext(db: ServiceClient, userId: string): Promise<EvalContext> {
  const [zones, { data: runs, error }] = await Promise.all([
    loadAthleteZones(db, userId),
    db
      .from("garmin_activities")
      .select("start_time, activity_type, avg_cadence, avg_ground_contact_ms, avg_vertical_oscillation")
      .eq("user_id", userId)
      .ilike("activity_type", "%running%"),
  ]);
  if (error) throw new Error(error.message);
  return {
    zones,
    dynamicsSamples: (runs ?? []).map((r) => ({
      startTime: new Date(r.start_time),
      activityType: r.activity_type,
      avgCadence: r.avg_cadence,
      avgGroundContactMs: r.avg_ground_contact_ms,
      avgVerticalOscillation: r.avg_vertical_oscillation,
    })),
  };
}

/**
 * Builds evaluateCompletion()'s input from the raw DB rows — shared by
 * matching and re-evaluation. Scored by what was actually done: a treadmill
 * session run outdoors (or the reverse) follows the rules of the activity's
 * own type, and the mismatch is returned so the caller can record it.
 */
function evaluateSessionAgainstActivity(
  sessionDetails: SessionEvalDetails,
  activityDetails: ActivityEvalDetails,
  ctx: EvalContext
): { evaluation: CompletionEvaluation | null; indoorMismatch: IndoorMismatch | null } {
  const modality = (sessionDetails.modality ?? "running") as Modality;
  const indoorMismatch = indoorMismatchOf(sessionDetails.indoor ?? false, modality, activityDetails.activity_type);
  // A race gets no score: its cartouche shows the result (time, distance, pace, HR).
  if (sessionDetails.session_type === "race") return { evaluation: null, indoorMismatch };
  const evaluation = evaluateCompletion({
    sessionType: sessionDetails.session_type as CompletionSessionType,
    targetDurationMinutes: sessionDetails.target_duration_minutes,
    targetPaceSecPerKm: sessionDetails.target_pace_sec_per_km,
    actualDurationSeconds: activityDetails.duration_seconds,
    actualAvgPaceSecPerKm: activityDetails.avg_pace_sec_per_km,
    actualAvgHeartRate: activityDetails.avg_heart_rate,
    zones: ctx.zones,
    actualMaxHeartRate: activityDetails.max_heart_rate,
    actualAvgCadence: activityDetails.avg_cadence,
    actualAvgGroundContactMs: activityDetails.avg_ground_contact_ms,
    actualAvgVerticalOscillation: activityDetails.avg_vertical_oscillation,
    actualAerobicTe: activityDetails.aerobic_te,
    actualTotalAscentM: activityDetails.total_ascent_m,
    actualGapPaceSecPerKm: activityDetails.gap_pace_sec_per_km,
    variant: sessionDetails.variant,
    indoor: modality === "running" && isIndoorActivity(activityDetails.activity_type),
    indoorMismatch,
    dynamicsBaseline: dynamicsBaselineAt(ctx.dynamicsSamples, new Date(activityDetails.start_time)),
    modality,
    steps: sessionDetails.steps,
    laps: activityDetails.laps,
  });
  return { evaluation, indoorMismatch };
}

/**
 * Links freshly-synced Garmin activities to this user's not-yet-completed
 * planned sessions (Prompt 8 spec). Best-effort and idempotent — safe to call
 * after every sync. Returns the number of sessions newly marked completed.
 */
export async function matchGarminActivitiesForUser(db: Db, userId: string): Promise<number> {

  const { data: candidateSessionRows, error: sessionsError } = await db
    .from("planned_sessions")
    .select("id, planned_date, indoor, modality, session_type, target_duration_minutes, target_pace_sec_per_km, variant, steps")
    .eq("user_id", userId)
    .eq("completed", false)
    .eq("skipped", false)
    .neq("session_type", "rest");
  if (sessionsError) throw new Error(sessionsError.message);
  if (!candidateSessionRows || candidateSessionRows.length === 0) return 0;

  const sessions: CandidateSession[] = candidateSessionRows.map((s) => ({
    id: s.id,
    plannedDate: new Date(s.planned_date + "T00:00:00Z"),
    indoor: s.indoor ?? false,
    modality: (s.modality ?? "running") as Modality,
  }));
  const sessionDetailsById = new Map(candidateSessionRows.map((s) => [s.id, s]));

  const dates = sessions.map((s) => s.plannedDate.getTime());
  const DAY_MS = 24 * 3600 * 1000;
  const rangeStart = new Date(Math.min(...dates) - DAY_MS).toISOString();
  const rangeEnd = new Date(Math.max(...dates) + 2 * DAY_MS).toISOString();

  const { data: activityRows, error: activitiesError } = await db
    .from("garmin_activities")
    .select(
      "garmin_activity_id, start_time, activity_type, duration_seconds, avg_pace_sec_per_km, avg_heart_rate, max_heart_rate, avg_cadence, avg_ground_contact_ms, avg_vertical_oscillation, aerobic_te, total_ascent_m, gap_pace_sec_per_km, laps"
    )
    .eq("user_id", userId)
    .gte("start_time", rangeStart)
    .lt("start_time", rangeEnd);
  if (activitiesError) throw new Error(activitiesError.message);
  if (!activityRows || activityRows.length === 0) return 0;
  const activityDetailsById = new Map(activityRows.map((a) => [a.garmin_activity_id, a]));

  // Don't re-match an activity that's already linked to some other session —
  // covers the case where that session has since been completed elsewhere.
  const { data: alreadyLinked, error: linkedError } = await db
    .from("planned_sessions")
    .select("garmin_activity_id")
    .eq("user_id", userId)
    .not("garmin_activity_id", "is", null);
  if (linkedError) throw new Error(linkedError.message);
  const linkedIds = new Set((alreadyLinked ?? []).map((r) => r.garmin_activity_id as number));

  const activities: CandidateActivity[] = activityRows
    .filter((a) => !linkedIds.has(a.garmin_activity_id))
    .map((a) => ({
      garminActivityId: a.garmin_activity_id,
      startTime: new Date(a.start_time),
      activityType: a.activity_type,
    }));

  const matches = matchActivitiesToSessions(activities, sessions);
  const ctx = matches.length > 0 ? await loadEvalContext(db, userId) : null;

  for (const m of matches) {
    const sessionDetails = sessionDetailsById.get(m.sessionId);
    const activityDetails = activityDetailsById.get(m.garminActivityId);
    const result =
      sessionDetails && activityDetails && ctx
        ? evaluateSessionAgainstActivity(sessionDetails, activityDetails, ctx)
        : null;
    const evaluation = result?.evaluation ?? null;

    const { error } = await db
      .from("planned_sessions")
      .update({
        completed: true,
        completed_at: m.completedAt.toISOString(),
        garmin_activity_id: m.garminActivityId,
        indoor_mismatch: m.indoorMismatch,
        completion_score: evaluation?.score ?? null,
        completion_note: evaluation?.note ?? null,
        completion_analysis: evaluation?.analysis ?? null,
      })
      .eq("id", m.sessionId);
    if (error) throw new Error(error.message);
  }

  return matches.length;
}

/**
 * Re-runs evaluateCompletion() on already-completed sessions against their
 * linked garmin_activity, and overwrites their stored completion_score/
 * completion_note/completion_analysis. For sessions matched before that
 * scoring logic existed or gained a field (e.g. the richer per-metric
 * analysis, or a CSV re-import that filled in previously-missing Garmin
 * fields for the same activity), or after the athlete's HR zones changed
 * (hr_max/hr_rest edited in /profil or raised from observed data) —
 * matchGarminActivitiesForUser() only ever
 * evaluates at match time, so these would otherwise keep a stale evaluation
 * forever. Best-effort and idempotent — safe to call after every sync/import.
 * Returns the number of sessions re-evaluated.
 */
export async function reevaluateCompletedSessionsForUser(db: Db, userId: string): Promise<number> {

  const { data: sessionRows, error: sessionsError } = await db
    .from("planned_sessions")
    .select("id, session_type, target_duration_minutes, target_pace_sec_per_km, garmin_activity_id, variant, indoor, modality, steps")
    .eq("user_id", userId)
    .eq("completed", true)
    .not("garmin_activity_id", "is", null)
    .neq("session_type", "rest");
  if (sessionsError) throw new Error(sessionsError.message);
  if (!sessionRows || sessionRows.length === 0) return 0;

  const activityIds = Array.from(new Set(sessionRows.map((s) => s.garmin_activity_id as number)));

  const { data: activityRows, error: activitiesError } = await db
    .from("garmin_activities")
    .select(
      "garmin_activity_id, start_time, activity_type, duration_seconds, avg_pace_sec_per_km, avg_heart_rate, max_heart_rate, avg_cadence, avg_ground_contact_ms, avg_vertical_oscillation, aerobic_te, total_ascent_m, gap_pace_sec_per_km, laps"
    )
    .eq("user_id", userId)
    .in("garmin_activity_id", activityIds);
  if (activitiesError) throw new Error(activitiesError.message);
  if (!activityRows || activityRows.length === 0) return 0;
  const activityDetailsById = new Map(activityRows.map((a) => [a.garmin_activity_id, a]));
  const ctx = await loadEvalContext(db, userId);

  let reevaluated = 0;
  for (const s of sessionRows) {
    const activityDetails = s.garmin_activity_id != null ? activityDetailsById.get(s.garmin_activity_id) : undefined;
    if (!activityDetails) continue;

    const { evaluation, indoorMismatch } = evaluateSessionAgainstActivity(s, activityDetails, ctx);

    const { error } = await db
      .from("planned_sessions")
      .update({
        indoor_mismatch: indoorMismatch,
        completion_score: evaluation?.score ?? null,
        completion_note: evaluation?.note ?? null,
        completion_analysis: evaluation?.analysis ?? null,
      })
      .eq("id", s.id);
    if (error) throw new Error(error.message);
    reevaluated++;
  }

  return reevaluated;
}
