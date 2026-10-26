// DB orchestration for (re)generating a user's week of planned_sessions.
// Shared by POST /api/plan/week (full regenerate) and the "reset day" action
// on PATCH /api/plan/session (which clears one session's override, then
// re-runs this to let the planner re-place it). Pure placement logic lives
// in lib/planner/rules.ts.

import type { Db } from "@/lib/supabase";
import { pushUserSessions } from "@/lib/google/sync";
import { loadAthleteCalibration } from "@/lib/athlete/profile";
import { loadRaces, attachRacePainWarnings } from "@/lib/races";
import type { DebriefView } from "@/lib/debrief";
import { loadDebriefViews, loadDebriefPlannerInput, loadDebriefSignals, resolveStaleEpisodes } from "@/lib/debrief";
import {
  buildWeekPlan,
  computeLongRunAnchorMinutes,
  longestRunMinutes,
  raceModeForWeek,
  resolveRacePlanWeek,
  isRaceActivity,
  goalRecoveryMode,
  trainingPhaseOf,
  RACE_PAIN_WARNING_MIN_SCORE,
  blockStartAfterRaces,
  evaluateBlockBoundary,
  isBlockBoundary,
  addDays,
  isoDate,
  parseIsoDate,
  fullWeeksBetween,
  type ProgressionState,
  type PlannedSession,
  type SubjectiveSignal,
  type NonImpactMachine,
  type KeptSession,
  type Modality,
  type SessionKind,
  type HeartRateZones,
} from "@/lib/planner";

/** French notice shown on a session card when a manual day override had to be dropped. */
export const DAY_OVERRIDE_DROPPED_NOTICE =
  "Jour déplacé — le jour choisi n'est plus disponible cette semaine.";

export interface RegenerateWeekParams {
  /** The signed-in user's client: Row Level Security applies to everything the generation reads and writes. */
  db: Db;
  userId: string;
  weekStart: Date; // Monday
  runsPerWeek: number;
  indoorRuns: number;
  /** Non-impact (bike/assault bike/elliptical) session count, 0-4. runsPerWeek + this is the week's total, 1-4. */
  nonImpactSessions: number;
  /** Machines the user has access to; required (non-empty) when nonImpactSessions > 0. */
  nonImpactMachines: NonImpactMachine[];
  /** 0=Mon..6=Sun, at least (runsPerWeek + nonImpactSessions) of them. */
  availableDays: number[];
}

export interface RegenerateWeekResult {
  ok: true;
  weekStart: string;
  phase: string;
  cycleWeekNumber: number;
  suggestedRunsPerWeek: 1 | 2 | 3;
  /** The athlete's HR zones the week was planned with — for the zone legend. */
  zones: HeartRateZones;
  sessions: Array<Record<string, unknown>>;
  googleCalendar: unknown;
}

export type RegenerateWeekError = { error: string; status: number };

type ServiceClient = Db;

/**
 * Adds `actual` (the linked Garmin activity's distance/duration/pace) to each
 * planned_sessions row — the shape GET /api/plan/week and the week card use.
 */
export async function attachActualActivities<T extends { id?: string; garmin_activity_id?: number | null }>(
  db: ServiceClient,
  userId: string,
  sessions: T[]
): Promise<Array<T & { actual: ActualActivity | null; debrief: DebriefView | null }>> {
  const debriefs = await loadDebriefViews(db, userId, sessions);
  const activityIds = sessions.map((s) => s.garmin_activity_id).filter((id): id is number => id != null);

  const activityMap = new Map<
    number,
    {
      distance_meters: number | null;
      duration_seconds: number | null;
      avg_pace_sec_per_km: number | null;
      avg_heart_rate: number | null;
    }
  >();
  if (activityIds.length > 0) {
    const { data: matchedActivities } = await db
      .from("garmin_activities")
      .select("garmin_activity_id, distance_meters, duration_seconds, avg_pace_sec_per_km, avg_heart_rate")
      .eq("user_id", userId)
      .in("garmin_activity_id", activityIds);
    for (const a of matchedActivities ?? []) activityMap.set(a.garmin_activity_id, a);
  }

  return sessions.map((s) => {
    const activity = s.garmin_activity_id != null ? activityMap.get(s.garmin_activity_id) : undefined;
    return {
      ...s,
      debrief: (s.id && debriefs.get(s.id)) || null,
      actual: activity
        ? {
            distanceKm: activity.distance_meters != null ? Math.round(activity.distance_meters / 100) / 10 : null,
            durationMinutes: activity.duration_seconds != null ? Math.round(activity.duration_seconds / 60) : null,
            durationSeconds: activity.duration_seconds,
            avgPaceSecPerKm: activity.avg_pace_sec_per_km,
            avgHeartRate: activity.avg_heart_rate,
          }
        : null,
    };
  });
}

export interface ActualActivity {
  distanceKm: number | null;
  durationMinutes: number | null;
  /** Unrounded — a race result is shown to the second. */
  durationSeconds: number | null;
  avgPaceSecPerKm: number | null;
  avgHeartRate: number | null;
}

function todayIsoDate(): string {
  return isoDate(new Date());
}

export async function regenerateWeekSessions(
  params: RegenerateWeekParams
): Promise<RegenerateWeekResult | RegenerateWeekError> {
  const { db, userId, weekStart, runsPerWeek, indoorRuns, nonImpactSessions, nonImpactMachines, availableDays } = params;
  const weekStartIso = isoDate(weekStart);
  const weekEndIso = isoDate(addDays(weekStart, 7));

  const { data: user, error: userError } = await db
    .from("users")
    .select("runs_per_week")
    .eq("id", userId)
    .maybeSingle();
  if (userError) return { error: userError.message, status: 500 };
  if (!user) return { error: "Unknown user.", status: 404 };

  // Long-run anchor: the longest run of the last 12 weeks (spec §1). Not a
  // prescription — the ceiling priority 3 may re-anchor the stored long run to,
  // and the starting value for a brand-new progression state.
  const activityCutoff = new Date();
  activityCutoff.setUTCDate(activityCutoff.getUTCDate() - 84);
  const { data: activities, error: activitiesError } = await db
    .from("garmin_activities")
    .select("start_time, duration_seconds, distance_meters, activity_type, event_type:raw_data->eventType->>typeKey")
    .eq("user_id", userId)
    .gte("start_time", activityCutoff.toISOString());
  if (activitiesError) return { error: activitiesError.message, status: 500 };

  // Races are not training runs: the anchor — like the race planner's — skips them (Garmin's race flag, or
  // an activity on a races row's date at about its distance).
  let races;
  try {
    races = await loadRaces(db, userId);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), status: 500 };
  }
  const activitySamples = (activities ?? [])
    .filter(
      (a) =>
        !isRaceActivity(
          {
            startTime: new Date(a.start_time),
            distanceKm: (a.distance_meters ?? 0) / 1000,
            eventType: (a as { event_type?: string | null }).event_type,
          },
          races
        )
    )
    .map((a) => ({
      startTime: new Date(a.start_time),
      durationSeconds: a.duration_seconds ?? 0,
      activityType: a.activity_type,
    }));
  const longRunAnchorMinutes = computeLongRunAnchorMinutes(activitySamples);

  // Load or create progression state.
  const { data: existingState, error: existingStateError } = await db
    .from("progression_state")
    .select(
      "cycle_start_date, phase, block_start_date, quality_level, suggested_runs_per_week, last_change_applied, long_run_minutes, previous_long_run_minutes"
    )
    .eq("user_id", userId)
    .maybeSingle();
  // Never fall through to a fresh state on a failed read — the upsert below would wipe real progress.
  if (existingStateError) return { error: existingStateError.message, status: 500 };

  let state: ProgressionState = existingState
    ? {
        cycleStartDate: parseIsoDate(existingState.cycle_start_date),
        phase: existingState.phase,
        blockStartDate: parseIsoDate(existingState.block_start_date),
        qualityLevel: existingState.quality_level,
        suggestedRunsPerWeek: existingState.suggested_runs_per_week,
        // Null until the first generation after onboarding: start from demonstrated capacity.
        longRunMinutes: existingState.long_run_minutes ?? longRunAnchorMinutes,
        previousLongRunMinutes: existingState.previous_long_run_minutes,
        lastChangeApplied: existingState.last_change_applied,
      }
    : {
        cycleStartDate: weekStart,
        phase: "base",
        blockStartDate: weekStart,
        qualityLevel: 0,
        suggestedRunsPerWeek: (user.runs_per_week ?? 2) as 1 | 2 | 3,
        longRunMinutes: longRunAnchorMinutes,
        previousLongRunMinutes: null,
        lastChangeApplied: null,
      };

  // Race mode (lib/planner/race.ts) overrides the progression engine and the
  // stored long run for the weeks around a race — and never touches
  // progression_state: no block evaluation, no write. After the recovery
  // week the block clock restarts.
  // Backward race planner: with a goal race ahead it supplies the week's volume, long run and key
  // session, and the progression engine stays out (no block evaluation, no write). Without one the
  // continuous mode — and the legacy race mode around a lone race — runs unchanged.
  const today = parseIsoDate(todayIsoDate());
  let flaggedDates: Date[];
  try {
    flaggedDates = (await loadDebriefSignals(db, userId, isoDate(addDays(today, -42)), isoDate(today)))
      .filter((s) => s.painScore >= RACE_PAIN_WARNING_MIN_SCORE)
      .map((s) => s.entryDate);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), status: 500 };
  }
  const { calibration: baseCalibration } = await loadAthleteCalibration(db, userId);
  const resolvedPlan = resolveRacePlanWeek({
    races,
    weekStart,
    today,
    activities: (activities ?? []).map((a) => {
      const startTime = new Date(a.start_time);
      const distanceKm = (a.distance_meters ?? 0) / 1000;
      return {
        startTime,
        distanceKm,
        durationMinutes: (a.duration_seconds ?? 0) / 60,
        activityType: a.activity_type,
        isRace: isRaceActivity({ startTime, distanceKm, eventType: (a as { event_type?: string | null }).event_type }, races),
      };
    }),
    flaggedDates,
    easyPaceSecPerKm: baseCalibration.easyPaceSecPerKm,
  });
  const racePlan = resolvedPlan?.input ?? null;
  const raceMode = resolvedPlan
    ? resolvedPlan.raceMode
    : (raceModeForWeek(races, weekStart, longestRunMinutes(activitySamples), state.longRunMinutes) ??
      goalRecoveryMode(races, weekStart));
  if (resolvedPlan) {
    state = {
      ...state,
      phase: trainingPhaseOf(resolvedPlan.week),
      qualityLevel: resolvedPlan.input.qualityLevel,
    };
  }
  if (!raceMode && !resolvedPlan) state = { ...state, blockStartDate: blockStartAfterRaces(races, weekStart, state.blockStartDate) };

  // If this week crosses a block boundary, evaluate the completed block's consistency
  // and apply the fixed-priority progression (frequency → quality volume → long-run re-anchor).
  if (!raceMode && !resolvedPlan && isBlockBoundary(state, weekStart)) {
    const { data: blockSessions } = await db
      .from("planned_sessions")
      .select("completed, session_type")
      .eq("user_id", userId)
      .gte("planned_date", isoDate(state.blockStartDate))
      .lt("planned_date", weekStartIso)
      .neq("session_type", "rest");

    const total = blockSessions?.length ?? 0;
    const completed = blockSessions?.filter((s) => s.completed).length ?? 0;
    const consistencyScorePct = total > 0 ? (completed / total) * 100 : null;

    state = evaluateBlockBoundary({ state, consistencyScorePct, weekStart, longRunAnchorMinutes });
  }

  if (!raceMode && !resolvedPlan) {
    const { error: stateError } = await db.from("progression_state").upsert({
      user_id: userId,
      cycle_start_date: isoDate(state.cycleStartDate),
      phase: state.phase,
      block_start_date: isoDate(state.blockStartDate),
      quality_level: state.qualityLevel,
      suggested_runs_per_week: state.suggestedRunsPerWeek,
      last_change_applied: state.lastChangeApplied,
      long_run_minutes: state.longRunMinutes,
      previous_long_run_minutes: state.previousLongRunMinutes,
      updated_at: new Date().toISOString(),
    });
    if (stateError) return { error: stateError.message, status: 500 };
  }

  // Recent debriefs, for the <48h-before-session downgrade check and the pain / gait quality block.
  // (subjective_entries stays in the database for history but no longer feeds the planner.)
  const weekEnd = addDays(weekStart, 6);
  let subjectiveEntries: SubjectiveSignal[];
  let qualityBlock: string | null;
  try {
    const todayIso = isoDate(today);
    await resolveStaleEpisodes(db, userId, todayIso);
    const loaded = await loadDebriefPlannerInput(
      db,
      userId,
      isoDate(addDays(weekStart, -10)),
      isoDate(weekEnd) < todayIso ? isoDate(weekEnd) : todayIso
    );
    subjectiveEntries = loaded.signals;
    qualityBlock = loaded.qualityBlock;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), status: 500 };
  }

  const cycleWeekNumber = fullWeeksBetween(state.cycleStartDate, weekStart) + 1;
  // Race-based paces (Riegel heuristics from the latest result) join the fitted easy pace and HR zones.
  const calibration = resolvedPlan?.paces
    ? {
        ...baseCalibration,
        marathonPaceSecPerKm: resolvedPlan.paces.marathonPaceSecPerKm,
        thresholdPaceSecPerKm: resolvedPlan.paces.thresholdPaceSecPerKm,
        vo2maxPaceSecPerKm: resolvedPlan.paces.vo2maxPaceSecPerKm,
        halfPaceSecPerKm: resolvedPlan.paces.halfPaceSecPerKm,
      }
    : baseCalibration;

  // Regeneration never touches a completed or skipped session, nor an
  // unresolved one dated before today: those are kept as-is and only the rest
  // of the week (unresolved sessions from today on) is replaced. The planner
  // plans just the slots and days they leave free.
  const todayIso = todayIsoDate();
  const { data: existingSessionRows, error: existingError } = await db
    .from("planned_sessions")
    .select("id, slot_index, manual_day_override, planned_date, completed, skipped, session_type, downgraded_from, modality, indoor")
    .eq("user_id", userId)
    .gte("planned_date", weekStartIso)
    .lt("planned_date", weekEndIso);
  if (existingError) return { error: existingError.message, status: 500 };

  const isKept = (row: { completed: boolean | null; skipped: boolean; planned_date: string }) =>
    Boolean(row.completed) || row.skipped || row.planned_date < todayIso;
  const keptRows = (existingSessionRows ?? []).filter(isKept);
  const replaceableRows = (existingSessionRows ?? []).filter((row) => !isKept(row));

  const dayOffsetOf = (plannedDate: string) =>
    Math.round((parseIsoDate(plannedDate).getTime() - weekStart.getTime()) / 86_400_000);
  const firstPlannableDay = Math.max(0, Math.min(7, dayOffsetOf(todayIso)));

  const keptSessions: KeptSession[] = keptRows.map((row) => ({
    dayOffset: dayOffsetOf(row.planned_date),
    modality: (row.modality ?? "running") as Modality,
    kind: row.session_type as SessionKind,
    downgradedFrom: (row.downgraded_from ?? null) as SessionKind | null,
    indoor: row.indoor ?? false,
    slotIndex: row.slot_index,
    // A skipped session didn't happen; a completed or still-pending past one did (or may yet be matched).
    countsAsHard: !row.skipped && (row.session_type === "threshold" || row.session_type === "vo2max"),
    skipped: row.skipped,
  }));

  // A long run on the previous week's Sunday makes this Monday "the day after
  // the long run" — no run there either (see avoidRunAfterLongRun in rules.ts).
  const { data: previousSundayLong, error: previousSundayError } = await db
    .from("planned_sessions")
    .select("id")
    .eq("user_id", userId)
    .eq("planned_date", isoDate(addDays(weekStart, -1)))
    .eq("modality", "running")
    .eq("skipped", false)
    .or("session_type.eq.long,downgraded_from.eq.long")
    .neq("session_type", "rest")
    .limit(1);
  if (previousSundayError) return { error: previousSundayError.message, status: 500 };

  // Carry forward manual day overrides from the sessions this regeneration
  // replaces. An override whose day is no longer plannable (not in
  // availableDays, already past, or taken by a kept session) is dropped —
  // auto-placement takes that slot back — and flagged in the response.
  const keptDays = new Set(keptSessions.map((k) => k.dayOffset));
  const availableSet = new Set(availableDays);
  const slotOverrides: Record<number, number> = {};
  const droppedOverrideSlotIndices = new Set<number>();
  for (const row of replaceableRows) {
    if (!row.manual_day_override || row.slot_index == null) continue;
    const offset = dayOffsetOf(row.planned_date);
    if (availableSet.has(offset) && offset >= firstPlannableDay && !keptDays.has(offset)) {
      slotOverrides[row.slot_index] = offset;
    } else {
      droppedOverrideSlotIndices.add(row.slot_index);
    }
  }

  const week = buildWeekPlan({
    userId,
    weekStartDate: weekStart,
    runsPerWeek,
    indoorRuns,
    nonImpactSessions,
    nonImpactMachines,
    cycleWeekNumber,
    phase: state.phase,
    qualityLevel: state.qualityLevel,
    longRunMinutes: state.longRunMinutes,
    calibration,
    subjectiveEntries,
    qualityBlock,
    availableDays,
    slotOverrides,
    keptSessions,
    firstPlannableDay,
    previousWeekLongRunOnSunday: (previousSundayLong ?? []).length > 0,
    raceMode,
    racePlan,
  });

  // Replace only the replaceable sessions.
  if (replaceableRows.length > 0) {
    const { error: deleteError } = await db
      .from("planned_sessions")
      .delete()
      .in("id", replaceableRows.map((row) => row.id));
    if (deleteError) return { error: deleteError.message, status: 500 };
  }

  const rows = week.sessions.map((s: PlannedSession, i: number) => ({
    user_id: s.userId,
    planned_date: isoDate(s.plannedDate),
    session_type: s.kind,
    session_label: s.label,
    variant: s.variant,
    modality: s.modality,
    indoor: s.indoor,
    incline_percent: s.inclinePercent,
    machine: s.machine,
    steps: s.steps,
    zone_summary: s.zoneSummary,
    downgraded_from: s.downgradedFrom,
    downgrade_reason: s.downgradeReason,
    strides_added: s.stridesAdded,
    target_distance_km: s.targetDistanceKm,
    target_duration_minutes: s.targetDurationMinutes,
    target_pace_sec_per_km: s.targetPaceSecondsPerKm,
    why_note: s.whyNote,
    slot_index: week.slotIndices[i],
    manual_day_override: week.slotIndices[i] in slotOverrides,
  }));

  if (rows.length > 0) {
    const { error: insertError } = await db.from("planned_sessions").insert(rows);
    if (insertError) return { error: insertError.message, status: 500 };
  }

  // The whole week — kept sessions included — so the client can replace its list.
  const { data: weekRows, error: weekError } = await db
    .from("planned_sessions")
    .select("*")
    .eq("user_id", userId)
    .gte("planned_date", weekStartIso)
    .lt("planned_date", weekEndIso)
    .order("planned_date", { ascending: true });
  if (weekError) return { error: weekError.message, status: 500 };

  const withActual = await attachRacePainWarnings(
    db,
    userId,
    await attachActualActivities(db, userId, weekRows ?? [])
  );
  const keptIds = new Set(keptRows.map((row) => row.id));
  const sessions = withActual.map((row) => ({
    ...row,
    day_override_dropped:
      !keptIds.has(row.id as string) &&
      row.slot_index != null &&
      droppedOverrideSlotIndices.has(row.slot_index as number),
  }));

  let googleCalendar: Awaited<ReturnType<typeof pushUserSessions>> | { skipped: true } = { skipped: true };
  try {
    googleCalendar = await pushUserSessions(db, userId);
  } catch (err) {
    console.warn(`Skipped Google Calendar push for user ${userId}:`, err instanceof Error ? err.message : err);
  }

  return {
    ok: true,
    weekStart: weekStartIso,
    phase: state.phase,
    cycleWeekNumber,
    suggestedRunsPerWeek: state.suggestedRunsPerWeek,
    zones: calibration.zones,
    sessions,
    googleCalendar,
  };
}
