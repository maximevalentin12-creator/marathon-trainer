// Public types for the training planner (see the README for the methodology they encode).

export type TrainingPhase = "base" | "developpement" | "specifique" | "decharge";

/**
 * "rest" is a real outcome: a planned run downgraded to a full rest day.
 * "race" is the race itself — only ever planned by race mode (see race.ts).
 */
export type SessionKind = "easy" | "long" | "threshold" | "vo2max" | "rest" | "race";

/**
 * Running vs. non-impact cardio (vélo d'appartement / assault bike /
 * élliptique) — same physiological roles (SessionKind), different modality.
 * Non-impact exists to grow cardio volume without extra joint/tendon load,
 * and as a fallback when pain is reported.
 */
export type Modality = "running" | "non_impact";

export type NonImpactMachine = "bike" | "assault_bike" | "elliptical";

export type SessionVariant =
  | "classic"
  | "fartlek"
  | "hills"
  | "continuous"
  | "progression"
  /** Long run with marathon-pace blocks (racePlan.ts specific phase). */
  | "mp_blocks"
  | "plain";

export type EffortZoneId = "echauffement" | "facile" | "aerobie" | "seuil" | "maximum";

/** A heart-rate zone described in plain language, never jargon (spec §5). */
export interface EffortZone {
  id: EffortZoneId;
  label: string;
  bpmMin: number;
  bpmMax: number;
  feeling: string;
}

/**
 * What the planner needs to know about the athlete: their HR zones (from
 * FC max / FC repos) and paces. HR zones lead; paces are indicative labels
 * and distance estimates (§1).
 */
export interface AthleteCalibration {
  zones: Record<EffortZoneId, EffortZone>;
  /** 10K reference pace in seconds/km. */
  paceReferenceSecPerKm: number;
  /** Facile/Longue target pace in seconds/km — fitted from the athlete's runs, or paceRef × 1.29. */
  easyPaceSecPerKm: number;
  /**
   * Paces predicted from the latest race result (paces.ts, Riegel heuristics) — set only
   * when a result exists. Threshold and VO2max sessions read them over paceRef when present.
   */
  marathonPaceSecPerKm?: number;
  thresholdPaceSecPerKm?: number;
  vo2maxPaceSecPerKm?: number;
  /** Half-marathon pace, for race-pace tempo sessions in a half-marathon block. */
  halfPaceSecPerKm?: number;
}

/** One row of a session's structure (warm-up, body, cooldown, ...). */
export interface SessionStep {
  label: string;
  /** Null for steps described by reps rather than a flat duration. */
  durationMinutes: number | null;
  description: string;
  zoneLabel: string;
  paceHint?: string;
  heartRateHint?: string;
}

export interface PlannedSession {
  userId: string;
  plannedDate: Date;
  kind: SessionKind;
  label: string;
  variant: SessionVariant;
  modality: Modality;
  indoor: boolean;
  /** Representative treadmill incline, null when it varies segment-to-segment (see steps). */
  inclinePercent: number | null;
  /** Which machine this non-impact session is on; null for running sessions. */
  machine: NonImpactMachine | null;
  targetDurationMinutes: number;
  targetDistanceKm: number | null;
  targetPaceSecondsPerKm: number | null;
  /** Human summary of the zone(s) this session moves through, e.g. "Facile → Aérobie". */
  zoneSummary: string;
  steps: SessionStep[];
  whyNote: string;
  zoneReference: EffortZone[];
  stridesAdded: boolean;
  downgradedFrom: SessionKind | null;
  downgradeReason: string | null;
}

export interface WeekPlan {
  userId: string;
  weekStartDate: Date;
  cycleWeekNumber: number;
  phase: TrainingPhase;
  /** Running session count, 0-4 — runsPerWeek + nonImpactSessions is the week's total, 1-4. */
  runsPerWeek: number;
  indoorRuns: number;
  nonImpactSessions: number;
  /** Only the sessions still to plan — kept sessions (PlannerInput.keptSessions) are not repeated here. */
  sessions: PlannedSession[];
  /** Architecture slot index of each entry in sessions (parallel array) — persisted as planned_sessions.slot_index. */
  slotIndices: number[];
}

/**
 * A session already in the week that regeneration keeps untouched: completed,
 * skipped, or unresolved but dated before today. It uses up its architecture
 * slot and its day, so only the remainder of the week gets planned.
 */
export interface KeptSession {
  /** 0=Mon..6=Sun */
  dayOffset: number;
  modality: Modality;
  kind: SessionKind;
  downgradedFrom: SessionKind | null;
  indoor: boolean;
  /** The architecture slot it was generated for, when known — preferred when matching it back to a slot. */
  slotIndex: number | null;
  /** Counts toward the week's single hard session (e.g. a completed Seuil/VO2max). */
  countsAsHard: boolean;
  /** Didn't happen — a skipped long run leaves no "day after" to protect. */
  skipped: boolean;
}

/**
 * Where a week sits relative to its race (race.ts raceWeekPosition):
 * peak (long run peak), reduction, race (the race week itself), recovery
 * (the week after).
 */
export type RaceWeekPosition = "peak" | "reduction" | "race" | "recovery";

/** Race mode for one week — overrides the progression engine's durations and roles, never the weekly setup. */
export interface RaceModeInput {
  position: RaceWeekPosition;
  raceName: string;
  raceDate: Date;
  distanceKm: number;
  /** Peak-week long run, already capped (race.ts peakLongRunMinutes). Only read when position is "peak". */
  peakLongRunMinutes: number;
  /** A solo test (bib_status 'solo_test') standing in for a race: same week shape, different wording. */
  soloTest?: boolean;
  /** Long run kept in the race week, in minutes — set when the race is under a half and leaves room 4+ days before it. */
  raceWeekLongRunMinutes?: number;
  /** Pace (sec/km) of the short reminders in the race week's first easy run (marathon / half pace); absent = none. */
  reminderPaceSecPerKm?: number;
}

/**
 * One week of the backward race plan (racePlan.ts), as the week generator
 * consumes it: the planned volume and long run replace the progression
 * engine's, the key session picks the quality role.
 */
export interface RacePlanWeekInput {
  phase: "recovery" | "base" | "development" | "specific" | "taper" | "race";
  targetKm: number;
  longRunMin: number;
  keySession:
    | "none"
    | "threshold"
    | "vo2max"
    | "mp_tempo"
    | "race_pace"
    | "mp_reminder"
    | "race"
    | "time_trial"
    | "long_tempo";
  isDeload: boolean;
  /** MP blocks inside the long run (marathon specific phase). */
  longRunMpBlock: { reps: number; kmEach: number } | null;
  /** First day (0 = Monday) quality may land on; the days before are easy after a race. */
  qualityFromDay: number;
  /** Last day (0 = Monday) quality may land on — before the 3-day pre-race window of a race early next week. */
  qualityUntilDay?: number;
  /** Last day (0 = Monday) the long run may land on — before the 4-day pre-race window. */
  longRunUntilDay?: number;
  qualityLevel: number;
}

/** A subjective_entries row, trimmed to what the downgrade rules need. */
export interface SubjectiveSignal {
  entryDate: Date;
  painScore: number;
  energyScore: number;
}

export interface PlannerInput {
  userId: string;
  /** Monday of the week to generate. */
  weekStartDate: Date;
  /** Running session count, 0-4. runsPerWeek + nonImpactSessions (the week's total) must be 1-4. */
  runsPerWeek: number;
  /** How many of runsPerWeek are indoor/treadmill; clamped to [0, runsPerWeek]. Never applies to non-impact sessions. */
  indoorRuns: number;
  /** Non-impact (bike/assault bike/elliptical) session count, 0-4. */
  nonImpactSessions: number;
  /** Machines the user has access to for non-impact sessions; empty only when nonImpactSessions is 0. */
  nonImpactMachines: NonImpactMachine[];
  /** 1-based week number since the progression cycle started — drives quality-role and variant rotation. */
  cycleWeekNumber: number;
  phase: TrainingPhase;
  /** Progression-controlled quality-session volume level (§3 priority 2), 0-based. */
  qualityLevel: number;
  /**
   * Prescribed long-run duration — progression_state.long_run_minutes, which
   * moves only through the progression engine (priority 3), never straight
   * from the live anchor. Easy runs derive from it.
   */
  longRunMinutes: number;
  /** The athlete's HR zones and paces (lib/athlete/profile.ts loadAthleteCalibration). */
  calibration: AthleteCalibration;
  /** Recent subjective_entries, used to find the most recent one <48h before each session (§2). */
  subjectiveEntries: SubjectiveSignal[];
  /** Days the user is available to train, 0=Mon..6=Sun. Must have at least runsPerWeek + nonImpactSessions entries. */
  availableDays: number[];
  /**
   * Manual per-session day overrides that are still valid (their day is
   * still in availableDays), keyed by slot index — i.e. the session's
   * position in that week's architecture array (see combinedArchitecture()),
   * as reported back in WeekPlan.slotIndices.
   */
  slotOverrides?: Record<number, number>;
  /** Sessions regeneration keeps as-is; their slots and days are not planned again. */
  keptSessions?: KeptSession[];
  /** Earliest day offset (0=Mon..7) new sessions may land on — today's, for the current week. Defaults to 0. */
  firstPlannableDay?: number;
  /** The previous week's long run was on its Sunday, so this Monday is "the day after the long run". */
  previousWeekLongRunOnSunday?: boolean;
  /** Set for the weeks around a race (race.ts raceModeForWeek); null/absent = a normal week. */
  raceMode?: RaceModeInput | null;
  /** The goal race's plan for this week (racePlan.ts); absent = the continuous mode. */
  racePlan?: RacePlanWeekInput | null;
}
