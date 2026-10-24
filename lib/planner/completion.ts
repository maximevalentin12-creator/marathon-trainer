// Pure matching logic for linking a Garmin activity to a planned session, and
// pure scoring logic for evaluating a completed session against its plan.
// DB orchestration lives in lib/garmin/matchSessions.ts.

import { nonImpactHeartRateZones, type HeartRateZones } from "./zones";
import type { EffortZone, EffortZoneId, Modality, SessionKind } from "./types";

export interface CandidateSession {
  id: string;
  /** UTC-midnight Date, matching planned_sessions.planned_date. */
  plannedDate: Date;
  indoor: boolean;
  modality: Modality;
}

export interface CandidateActivity {
  garminActivityId: number;
  startTime: Date;
  activityType: string | null;
}

export interface MatchResult {
  sessionId: string;
  garminActivityId: number;
  completedAt: Date;
  /** Running only: planned on the treadmill but done outdoors, or the reverse. */
  indoorMismatch: IndoorMismatch | null;
}

export type IndoorMismatch = "outdoor_instead_of_treadmill" | "treadmill_instead_of_outdoor";

const INDOOR_MISMATCH_NOTE_FR: Record<IndoorMismatch, string> = {
  outdoor_instead_of_treadmill: "Faite en extérieur au lieu du tapis",
  treadmill_instead_of_outdoor: "Faite sur tapis au lieu de l'extérieur",
};

/** How a running activity's location compares to the session's plan; null when they agree or it isn't running. */
export function indoorMismatchOf(
  plannedIndoor: boolean,
  modality: Modality,
  activityType: string | null
): IndoorMismatch | null {
  if (modality !== "running") return null;
  const doneIndoor = isIndoorActivity(activityType);
  if (doneIndoor === plannedIndoor) return null;
  return doneIndoor ? "treadmill_instead_of_outdoor" : "outdoor_instead_of_treadmill";
}

/**
 * Which modality a Garmin activity type belongs to, or null when it's
 * neither running nor a recognized non-impact modality (e.g. swimming) — such
 * activities never auto-complete a planned session, running or non-impact.
 */
export function activityModality(activityType: string | null): Modality | null {
  const v = (activityType ?? "").toLowerCase();
  if (v.includes("running")) return "running";
  if (v.includes("cycling") || v.includes("elliptical")) return "non_impact";
  return null;
}

/** Garmin's activityType.typeKey: "treadmill_running" is the only indoor running type. */
export function isIndoorActivity(activityType: string | null): boolean {
  return (activityType ?? "").toLowerCase() === "treadmill_running";
}

function dateOnlyDiffDays(a: Date, b: Date): number {
  const aUtc = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const bUtc = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((aUtc - bUtc) / (24 * 3600 * 1000));
}

/**
 * Matches candidate activities to candidate sessions: same user (both lists
 * are assumed pre-scoped to one), same modality, planned date within ±1 day
 * of the activity's start time. Indoor/outdoor disagreement (a treadmill run
 * for an outdoor session, or the reverse) doesn't prevent a match — the
 * session was still done — but the result records it. Each session is
 * claimed by at most one activity and vice versa. Ties resolve globally:
 * closest date first, then indoor/outdoor agreement, then start time.
 */
export function matchActivitiesToSessions(
  activities: CandidateActivity[],
  sessions: CandidateSession[]
): MatchResult[] {
  const recognizedActivities = activities
    .map((a) => ({ activity: a, modality: activityModality(a.activityType) }))
    .filter((a): a is { activity: CandidateActivity; modality: Modality } => a.modality !== null);

  const pairs: Array<{
    activity: CandidateActivity;
    session: CandidateSession;
    diff: number;
    mismatch: IndoorMismatch | null;
  }> = [];
  for (const { activity, modality } of recognizedActivities) {
    for (const session of sessions) {
      if (session.modality !== modality) continue;
      const diff = Math.abs(dateOnlyDiffDays(activity.startTime, session.plannedDate));
      if (diff > 1) continue;
      pairs.push({ activity, session, diff, mismatch: indoorMismatchOf(session.indoor, modality, activity.activityType) });
    }
  }

  pairs.sort(
    (a, b) =>
      a.diff - b.diff ||
      Number(a.mismatch !== null) - Number(b.mismatch !== null) ||
      a.activity.startTime.getTime() - b.activity.startTime.getTime()
  );

  const claimedActivities = new Set<number>();
  const claimedSessions = new Set<string>();
  const results: MatchResult[] = [];

  for (const { activity, session, mismatch } of pairs) {
    if (claimedActivities.has(activity.garminActivityId) || claimedSessions.has(session.id)) continue;
    claimedActivities.add(activity.garminActivityId);
    claimedSessions.add(session.id);
    results.push({
      sessionId: session.id,
      garminActivityId: activity.garminActivityId,
      completedAt: activity.startTime,
      indoorMismatch: mismatch,
    });
  }

  return results;
}

// ─── Post-session evaluation ───────────────────────────────────────────────

/**
 * Session kinds that get a score. Rest is never matched; a race is matched
 * like any run but never scored — its cartouche shows the result instead.
 */
export type CompletionSessionType = Exclude<SessionKind, "rest" | "race">;

export interface CompletionEvalInput {
  sessionType: CompletionSessionType;
  targetDurationMinutes: number | null;
  /** Null for vo2max sessions, which are HR/feel-based rather than pace-based. */
  targetPaceSecPerKm: number | null;
  actualDurationSeconds: number | null;
  actualAvgPaceSecPerKm: number | null;
  actualAvgHeartRate: number | null;
  /** The athlete's running HR zones (lib/athlete/profile.ts); non-impact sessions shift them. */
  zones: HeartRateZones;
  /** Richer Garmin metrics — all optional, since older imports/activities may lack them. */
  actualMaxHeartRate?: number | null;
  actualAvgCadence?: number | null;
  actualAvgGroundContactMs?: number | null;
  /** Centimeters. */
  actualAvgVerticalOscillation?: number | null;
  actualAerobicTe?: number | null;
  actualTotalAscentM?: number | null;
  actualGapPaceSecPerKm?: number | null;
  /** planned_sessions.variant — a "fartlek" quality session has no work blocks to isolate. */
  variant?: string | null;
  /**
   * The activity was ACTUALLY done on a treadmill (not what was planned):
   * intensity is scored on HR only — wrist-based treadmill distance (so pace)
   * is unreliable — and running dynamics aren't compared to the outdoor baseline.
   */
  indoor?: boolean;
  /** Set when the run was done indoors/outdoors against the plan — noted, and scored by what was actually done. */
  indoorMismatch?: IndoorMismatch | null;
  /** The athlete's usual running dynamics (dynamicsBaselineAt); null fields = not enough history. */
  dynamicsBaseline?: DynamicsBaseline | null;
  /** Non-impact sessions use the shifted HR zones and never pace. Defaults to running. */
  modality?: Modality;
  /** planned_sessions.steps — the prescribed structure work laps are identified against. */
  steps?: PrescribedStep[] | null;
  /** garmin_activities.laps — fetched only for activities matched to quality sessions. */
  laps?: ActivityLap[] | null;
}

/** One lap of a Garmin activity, as stored in garmin_activities.laps by scripts/sync_garmin.py --fetch-laps. */
export interface ActivityLap {
  index: number;
  durationSeconds: number | null;
  distanceMeters: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgPaceSecPerKm: number | null;
  /** Garmin's lap intensityType (WARMUP/INTERVAL/RECOVERY/COOLDOWN/ACTIVE/REST) — set when run as a structured workout. */
  intensityType: string | null;
}

/** The parts of a planned_sessions.steps entry scoring needs. */
export interface PrescribedStep {
  durationMinutes: number | null;
  description?: string;
}

export interface CompletionEvaluation {
  /** 0-100, rounded. */
  score: number;
  /** Short, factual, French explanation — up to two comma-separated reasons. */
  note: string;
  /** 2-5 specific French observations drawn from the richer Garmin metrics, for display below the note. */
  analysis: string[];
}

/**
 * Pace tolerance around the stored target_pace_sec_per_km, in sec/km.
 * "under" = how much faster than target is still acceptable; "over" = how
 * much slower. Easy/long get a wide, slower-leaning band (going out too fast
 * is the real risk on those); threshold mirrors the ±5 the planner's own
 * pace-hint range implies around its target (see rules.ts).
 */
const PACE_TOLERANCE_SEC_PER_KM: Partial<Record<CompletionSessionType, { under: number; over: number }>> = {
  easy: { under: 15, over: 45 },
  long: { under: 15, over: 45 },
  threshold: { under: 5, over: 5 },
};

function zonesFor(modality: Modality | undefined, zones: HeartRateZones): HeartRateZones {
  return modality === "non_impact" ? nonImpactHeartRateZones(zones) : zones;
}

/**
 * A progression long run spends ~88% of its time in Facile and the final ~12%
 * in Aérobie (see buildLongSteps() in rules.ts), which lifts the whole-session
 * average ceiling a few bpm: Facile's top plus this margin.
 */
const PROGRESSION_LONG_HR_CEILING_MARGIN_BPM = 4;

/**
 * Whole-session HR band for continuous sessions — the zone the spec pilots
 * them by: Facile, except a progression long run, whose Aérobie finish
 * raises the ceiling slightly.
 */
function continuousHrRange(
  sessionType: "easy" | "long",
  variant: string | null | undefined,
  zones: Record<EffortZoneId, EffortZone>
) {
  const progression = sessionType === "long" && variant === "progression";
  return {
    min: zones.facile.bpmMin,
    max: zones.facile.bpmMax + (progression ? PROGRESSION_LONG_HR_CEILING_MARGIN_BPM : 0),
  };
}

/**
 * VO2max/hills reps are piloted by feel; HR is only a check that should reach
 * "haut de zone Seuil / début de zone Maximum" by the END of each rep (spec
 * §4) — so each work lap's max HR is compared to upper-Seuil..lower-Maximum.
 */
function endOfRepHrRange(zones: Record<EffortZoneId, EffortZone>) {
  return {
    min: Math.round((zones.seuil.bpmMin + zones.seuil.bpmMax) / 2),
    max: Math.round((zones.maximum.bpmMin + zones.maximum.bpmMax) / 2),
  };
}

/** 100 inside [lo, hi], degrading linearly with how far outside the band the value falls. */
function zoneAdherenceScore(actual: number, lo: number, hi: number): number {
  if (actual >= lo && actual <= hi) return 100;
  const width = hi - lo || 1;
  const overshoot = actual < lo ? lo - actual : actual - hi;
  return Math.max(0, Math.round(100 - (overshoot / width) * 100));
}

// ─── Richer post-session analysis (Garmin dynamics: HR spread, cadence, ground
// contact, vertical oscillation, aerobic TE, elevation) ────────────────────

const HR_SPREAD_THRESHOLD_BPM = 30;
const HILLY_ASCENT_THRESHOLD_M = 100;

// Running dynamics are judged against the athlete's own baseline, never
// population norms (160 spm / 300 ms / 9 cm flagged nearly every run of an
// 85 kg runner): the median of his last 20 outdoor runs, flagged only past a
// clear deviation in the unfavourable direction.
const DYNAMICS_BASELINE_RUNS = 20;
const DYNAMICS_MIN_BASELINE_RUNS = 8;
const DYNAMICS_DEVIATION = 0.05;

export interface DynamicsSample {
  startTime: Date;
  activityType: string | null;
  avgCadence: number | null;
  avgGroundContactMs: number | null;
  /** Centimeters. */
  avgVerticalOscillation: number | null;
}

export interface DynamicsBaseline {
  cadence: number | null;
  groundContactMs: number | null;
  verticalOscillationCm: number | null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Medians of each running-dynamics metric over the last 20 outdoor runs
 * (treadmill excluded) started before `before` — the session's own activity
 * never counts toward its baseline. A metric with fewer than 8 values in
 * that window is null: not enough history to say what's usual.
 */
export function dynamicsBaselineAt(samples: DynamicsSample[], before: Date): DynamicsBaseline {
  const prior = samples
    .filter((s) => activityModality(s.activityType) === "running" && !isIndoorActivity(s.activityType))
    .filter((s) => s.startTime < before)
    .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
    .slice(0, DYNAMICS_BASELINE_RUNS);
  const metric = (pick: (s: DynamicsSample) => number | null) => {
    const values = prior.map(pick).filter((v): v is number => v != null);
    return values.length >= DYNAMICS_MIN_BASELINE_RUNS ? median(values) : null;
  };
  return {
    cadence: metric((s) => s.avgCadence),
    groundContactMs: metric((s) => s.avgGroundContactMs),
    verticalOscillationCm: metric((s) => s.avgVerticalOscillation),
  };
}

const fmtFr = (n: number, digits = 0) => n.toLocaleString("fr-FR", { maximumFractionDigits: digits });

/** Expected "TE aérobie" range per session type — outside of it, the effort's aerobic/anaerobic mix doesn't match the intent. */
const AEROBIC_TE_RANGE: Record<CompletionSessionType, { min: number; max: number }> = {
  easy: { min: 2, max: 3 },
  // TE rises with duration: a 65-75 min easy run often lands just above 3.
  long: { min: 2, max: 3.5 },
  threshold: { min: 3, max: 4 },
  vo2max: { min: 4, max: 5 },
};

const SESSION_TYPE_LABEL_FR: Record<CompletionSessionType, string> = {
  easy: "facile",
  long: "longue",
  threshold: "seuil",
  vo2max: "VO2max",
};

function fmtPaceSecPerKm(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = String(Math.round(sec % 60)).padStart(2, "0");
  return `${m}:${s}/km`;
}

/**
 * Rule-based checks over the richer Garmin dynamics fields. Each check that
 * fires contributes both a display message and a short "cause" phrase used
 * to build the "pistes de réflexion" summary line when the score is low.
 * Independent of scoring — these are informational, not score inputs.
 */
function buildAnalysis(
  input: CompletionEvalInput,
  paceRange: { lo: number; hi: number } | null
): { messages: string[]; causes: string[] } {
  const { sessionType, actualAvgPaceSecPerKm, actualAvgHeartRate } = input;
  const checks: Array<{ cause: string; message: string }> = [];

  if (
    (sessionType === "easy" || sessionType === "long") &&
    actualAvgHeartRate != null &&
    input.actualMaxHeartRate != null &&
    input.actualMaxHeartRate - actualAvgHeartRate > HR_SPREAD_THRESHOLD_BPM
  ) {
    checks.push({
      cause: "des pics d'intensité",
      message: "Pics d'intensité sur une séance censée rester facile",
    });
  }

  // Outdoor runs only — treadmill dynamics differ and the baseline is outdoor.
  const base = (input.modality ?? "running") === "running" && !input.indoor ? input.dynamicsBaseline : null;
  if (base) {
    const cad = input.actualAvgCadence;
    if (cad != null && base.cadence != null && cad < base.cadence * (1 - DYNAMICS_DEVIATION)) {
      checks.push({
        cause: "une cadence plus basse que d'habitude",
        message: `Cadence plus basse que ta moyenne habituelle (${fmtFr(cad)} pas/min contre ${fmtFr(base.cadence)})`,
      });
    }
    const gct = input.actualAvgGroundContactMs;
    if (gct != null && base.groundContactMs != null && gct > base.groundContactMs * (1 + DYNAMICS_DEVIATION)) {
      checks.push({
        cause: "un temps de contact au sol plus long que d'habitude",
        message: `Temps de contact au sol plus long que ta moyenne habituelle (${fmtFr(gct)} ms contre ${fmtFr(base.groundContactMs)}) — signe possible de fatigue`,
      });
    }
    const vo = input.actualAvgVerticalOscillation;
    if (vo != null && base.verticalOscillationCm != null && vo > base.verticalOscillationCm * (1 + DYNAMICS_DEVIATION)) {
      checks.push({
        cause: "une oscillation verticale plus haute que d'habitude",
        message: `Oscillation verticale plus haute que ta moyenne habituelle (${fmtFr(vo, 1)} cm contre ${fmtFr(base.verticalOscillationCm, 1)})`,
      });
    }
  }

  if (input.actualAerobicTe != null) {
    const range = AEROBIC_TE_RANGE[sessionType];
    if (input.actualAerobicTe < range.min || input.actualAerobicTe > range.max) {
      checks.push({
        cause: "un effort aérobie décalé par rapport à la séance",
        message: `TE aérobie de ${fmtFr(input.actualAerobicTe, 1)}, hors de la plage attendue (${fmtFr(range.min, 1)}-${fmtFr(range.max, 1)}) pour une séance ${SESSION_TYPE_LABEL_FR[sessionType]}`,
      });
    }
  }

  if (
    paceRange &&
    actualAvgPaceSecPerKm != null &&
    actualAvgPaceSecPerKm > paceRange.hi &&
    input.actualTotalAscentM != null &&
    input.actualTotalAscentM > HILLY_ASCENT_THRESHOLD_M
  ) {
    const gapNote =
      input.actualGapPaceSecPerKm != null ? ` (GAP : ${fmtPaceSecPerKm(input.actualGapPaceSecPerKm)})` : "";
    checks.push({
      cause: "le dénivelé",
      message: `Allure ralentie par le dénivelé — ${Math.round(input.actualTotalAscentM)} m de D+${gapNote}`,
    });
  }

  return { messages: checks.slice(0, 4).map((c) => c.message), causes: checks.map((c) => c.cause) };
}

// ─── Quality sessions: work-lap identification ─────────────────────────────

/** Rep structure parsed from a quality session's steps (warm-up, "N × M min" body, cool-down). */
interface IntervalStructure {
  reps: number;
  workSec: number;
  recoverySec: number;
  warmSec: number | null;
  coolSec: number | null;
}

const REPS_PATTERN = /(\d+)\s*×\s*(\d+)\s*min/;

function prescribedIntervals(steps: PrescribedStep[] | null | undefined): IntervalStructure | null {
  if (!steps) return null;
  const corpsIndex = steps.findIndex((st) => st.durationMinutes != null && REPS_PATTERN.test(st.description ?? ""));
  if (corpsIndex === -1) return null;
  const match = REPS_PATTERN.exec(steps[corpsIndex].description ?? "");
  if (!match) return null;
  const reps = Number(match[1]);
  const workMin = Number(match[2]);
  const corpsMin = steps[corpsIndex].durationMinutes ?? 0;
  // The body step's duration is reps × work + (reps − 1) × recovery (see rules.ts / nonImpact.ts).
  const recoveryMin = reps > 1 ? (corpsMin - reps * workMin) / (reps - 1) : 0;
  if (reps < 1 || workMin <= 0 || recoveryMin < 0) return null;
  const minutesToSec = (m: number | null | undefined) => (m != null ? m * 60 : null);
  return {
    reps,
    workSec: workMin * 60,
    recoverySec: recoveryMin * 60,
    warmSec: minutesToSec(steps[corpsIndex - 1]?.durationMinutes),
    coolSec: minutesToSec(steps[corpsIndex + 1]?.durationMinutes),
  };
}

function withinTolerance(actualSec: number, expectedSec: number, absSec: number, rel: number): boolean {
  return Math.abs(actualSec - expectedSec) <= Math.max(absSec, expectedSec * rel);
}

const workLapFits = (lap: ActivityLap, s: IntervalStructure) =>
  lap.durationSeconds != null && withinTolerance(lap.durationSeconds, s.workSec, 30, 0.15);

const STRUCTURED_INTENSITY_TYPES = new Set(["WARMUP", "COOLDOWN", "RECOVERY", "REST", "INTERVAL"]);

/**
 * The laps that are the prescribed work reps, or null when the laps don't
 * line up with the structure (e.g. 1 km auto-laps) — never a guess. Accepts
 * either a structured watch workout (laps typed INTERVAL, or ACTIVE between
 * RECOVERY/REST laps) or manual laps in the exact prescribed order:
 * warm-up, rep, recovery, …, rep, cool-down. Work laps must match the rep
 * duration closely; warm-up/recovery/cool-down loosely.
 */
function identifyWorkLaps(laps: ActivityLap[], s: IntervalStructure): ActivityLap[] | null {
  const typeOf = (lap: ActivityLap) => (lap.intensityType ?? "").toUpperCase();

  if (laps.some((lap) => STRUCTURED_INTENSITY_TYPES.has(typeOf(lap)))) {
    const intervals = laps.filter((lap) => typeOf(lap) === "INTERVAL");
    const work = intervals.length > 0 ? intervals : laps.filter((lap) => typeOf(lap) === "ACTIVE");
    if (work.length === s.reps && work.every((lap) => workLapFits(lap, s))) return work;
  }

  const expected: Array<number | null> = [
    s.warmSec,
    ...Array.from({ length: 2 * s.reps - 1 }, (_, i) => (i % 2 === 0 ? s.workSec : s.recoverySec)),
    s.coolSec,
  ];
  if (laps.length !== expected.length) return null;
  const aligned = laps.every((lap, i) => {
    const e = expected[i];
    if (lap.durationSeconds == null) return false;
    if (e == null) return true;
    return i % 2 === 1 ? workLapFits(lap, s) : withinTolerance(lap.durationSeconds, e, 90, 0.5);
  });
  return aligned ? laps.filter((_, i) => i % 2 === 1) : null;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Intensity on the work laps only. Threshold: each rep's average HR against
 * the Seuil zone and, off the treadmill, its pace against the threshold
 * target. VO2max/hills: each rep's max HR (proxy for end-of-rep HR) against
 * upper-Seuil..lower-Maximum.
 */
function scoreWorkLaps(
  sessionType: "threshold" | "vo2max",
  work: ActivityLap[],
  zones: Record<EffortZoneId, EffortZone>,
  paceRange: { lo: number; hi: number } | null
): { score: number; reason: string | null } | null {
  if (sessionType === "vo2max") {
    const range = endOfRepHrRange(zones);
    const maxHrs = work.map((lap) => lap.maxHr).filter((v): v is number => v != null);
    if (maxHrs.length === 0) return null;
    const avgMax = mean(maxHrs);
    return {
      score: mean(maxHrs.map((hr) => zoneAdherenceScore(hr, range.min, range.max))),
      reason:
        avgMax < range.min
          ? "FC de fin de répétition sous la cible"
          : avgMax > range.max
            ? "FC de fin de répétition au-dessus de la cible"
            : null,
    };
  }

  const seuil = zones.seuil;
  const lapScores: number[] = [];
  const hrs: number[] = [];
  const paces: number[] = [];
  for (const lap of work) {
    const parts: number[] = [];
    if (lap.avgHr != null) {
      parts.push(zoneAdherenceScore(lap.avgHr, seuil.bpmMin, seuil.bpmMax));
      hrs.push(lap.avgHr);
    }
    if (paceRange && lap.avgPaceSecPerKm != null) {
      parts.push(zoneAdherenceScore(lap.avgPaceSecPerKm, paceRange.lo, paceRange.hi));
      paces.push(lap.avgPaceSecPerKm);
    }
    if (parts.length > 0) lapScores.push(mean(parts));
  }
  if (lapScores.length === 0) return null;

  let reason: string | null = null;
  if (hrs.length > 0 && mean(hrs) < seuil.bpmMin) reason = "Blocs sous la zone Seuil";
  else if (hrs.length > 0 && mean(hrs) > seuil.bpmMax) reason = "Blocs au-dessus de la zone Seuil";
  else if (paceRange && paces.length > 0 && mean(paces) > paceRange.hi) reason = "Blocs plus lents que l'allure Seuil";
  else if (paceRange && paces.length > 0 && mean(paces) < paceRange.lo) reason = "Blocs plus rapides que l'allure Seuil";
  return { score: mean(lapScores), reason };
}

// ─── Scoring ────────────────────────────────────────────────────────────────

/**
 * Scores a completed session against its plan (duration 60% / intensity 40%)
 * and generates a short French explanation from the same data. Intensity:
 * - easy/long (continuous): whole-session average HR against the zone; pace
 *   only when HR is missing (spec: HR wins over pace), never on a treadmill.
 * - threshold/vo2max: the work laps only (see scoreWorkLaps) — never a
 *   whole-session average, which warm-up/recoveries/cool-down drag below the
 *   work zone. When laps don't line up with the prescribed structure, or it's
 *   a fartlek, intensity falls back to aerobic TE and the note says so.
 * Returns null only when there isn't even enough data to score duration (no
 * target or no actual duration) — the caller should leave
 * completion_score/completion_note unset in that case.
 */
export function evaluateCompletion(input: CompletionEvalInput): CompletionEvaluation | null {
  const {
    sessionType,
    targetDurationMinutes,
    targetPaceSecPerKm,
    actualDurationSeconds,
    actualAvgPaceSecPerKm,
    actualAvgHeartRate,
  } = input;

  if (targetDurationMinutes == null || targetDurationMinutes <= 0 || actualDurationSeconds == null) {
    return null;
  }

  const actualDurationMinutes = actualDurationSeconds / 60;
  const durationScore = Math.min(100, (actualDurationMinutes / targetDurationMinutes) * 100);

  const zones = zonesFor(input.modality, input.zones);
  const pacePilotable = !input.indoor && (input.modality ?? "running") === "running";
  let paceRange: { lo: number; hi: number } | null = null;
  if (pacePilotable && targetPaceSecPerKm != null) {
    const tol = PACE_TOLERANCE_SEC_PER_KM[sessionType] ?? { under: 10, over: 10 };
    paceRange = { lo: targetPaceSecPerKm - tol.under, hi: targetPaceSecPerKm + tol.over };
  }

  let intensityScore: number | null = null;
  let basisNote = "";
  const intensityReasons: string[] = [];

  if (sessionType === "easy" || sessionType === "long") {
    const hrRange = continuousHrRange(sessionType, input.variant, zones);
    if (actualAvgHeartRate != null) {
      intensityScore = zoneAdherenceScore(actualAvgHeartRate, hrRange.min, hrRange.max);
      if (actualAvgHeartRate > hrRange.max) intensityReasons.push("Intensité plus élevée que prévu");
    } else if (paceRange && actualAvgPaceSecPerKm != null) {
      intensityScore = zoneAdherenceScore(actualAvgPaceSecPerKm, paceRange.lo, paceRange.hi);
      if (actualAvgPaceSecPerKm < paceRange.lo) intensityReasons.push("Allure trop rapide pour une séance facile");
      else if (actualAvgPaceSecPerKm > paceRange.hi) intensityReasons.push("Rythme plus lent que prévu");
    } else {
      basisNote = input.indoor
        ? " (score basé sur la durée uniquement : pas de FC, et l'allure sur tapis n'est pas fiable)"
        : " (score basé sur la durée uniquement, données de rythme/FC insuffisantes)";
    }
  } else {
    const structure = input.variant === "fartlek" ? null : prescribedIntervals(input.steps);
    const laps = [...(input.laps ?? [])].sort((a, b) => a.index - b.index);
    const work = structure && laps.length > 0 ? identifyWorkLaps(laps, structure) : null;
    const lapResult = work ? scoreWorkLaps(sessionType, work, zones, paceRange) : null;

    if (lapResult) {
      intensityScore = lapResult.score;
      if (lapResult.reason) intensityReasons.push(lapResult.reason);
    } else {
      const why =
        input.variant === "fartlek"
          ? "fartlek, pas de blocs de travail à isoler"
          : !structure
            ? "structure prévue non disponible"
            : laps.length === 0
              ? "tours non disponibles"
              : !work
                ? "tours non alignés sur la structure prévue"
                : "pas de FC sur les blocs de travail";
      const te = input.actualAerobicTe;
      if (te != null) {
        const range = AEROBIC_TE_RANGE[sessionType];
        intensityScore = zoneAdherenceScore(te, range.min, range.max);
        if (te < range.min) intensityReasons.push("Effort plus léger que prévu");
        else if (te > range.max) intensityReasons.push("Effort plus intense que prévu");
        basisNote = ` (intensité estimée via le TE aérobie : ${why})`;
      } else {
        basisNote = ` (score basé sur la durée uniquement : ${why}, TE aérobie absent)`;
      }
    }
  }

  const score = Math.round(
    intensityScore == null ? durationScore : durationScore * 0.6 + intensityScore * 0.4
  );

  const reasons: string[] = [];
  if (score < 95) {
    if (actualDurationMinutes < targetDurationMinutes * 0.85) reasons.push("Séance écourtée");
    reasons.push(...intensityReasons);
  }

  let note: string;
  if (reasons.length > 0) {
    note = reasons.slice(0, 2).join(", ");
  } else if (score >= 95) {
    note = "Séance respectée";
  } else {
    note = "Écart mineur par rapport au plan";
  }
  note += basisNote;
  if (input.indoorMismatch) note = `${INDOOR_MISMATCH_NOTE_FR[input.indoorMismatch]} — ${note}`;

  const { messages, causes } = buildAnalysis(input, paceRange);
  const analysis = [...messages];
  if (score < 85 && causes.length > 0) {
    const verb = causes.length > 1 ? "pourraient" : "pourrait";
    analysis.push(`Piste de réflexion : ${causes.join(", ")} ${verb} expliquer l'écart de score.`);
  }

  return { score, note, analysis };
}
