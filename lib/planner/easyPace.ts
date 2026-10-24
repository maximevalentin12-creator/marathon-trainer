// Easy (Facile/Longue) target pace, estimated from the athlete's own runs:
// a linear fit of pace against average HR over recent outdoor easy and long
// runs, read off near the top of the Facile zone. Falls back to the fixed
// paceRef × 1.29 relationship when there's too little data or the fit isn't
// plausible. Pure — the DB query lives in lib/athlete/profile.ts.

import type { SessionKind } from "./types";
import type { HeartRateZones } from "./zones";

/** Look-back window for the fit (same 12 weeks as the long-run anchor). */
export const EASY_PACE_WINDOW_DAYS = 84;
export const EASY_PACE_MIN_RUNS = 5;

/** Below this a "run" is a warm-up jog or an aborted recording — not representative. */
const MIN_RUN_SECONDS = 20 * 60;
/** Where the fitted line is read: just under the top of Facile, so the target stays easy. */
const TARGET_BPM_BELOW_FACILE_TOP = 2;
/** Don't read the line further than this beyond the HR range the runs actually cover. */
const MAX_EXTRAPOLATION_BPM = 8;
/** Plausible slope, sec/km per bpm: pace must get faster as HR rises, but not absurdly so. */
const SLOPE_RANGE = { min: -15, max: -0.5 };
/** Plausible result relative to the 10K reference pace (the formula sits at ×1.29). */
const PACE_REF_RATIO_RANGE = { min: 1.05, max: 1.6 };

function round5(n: number): number {
  return Math.round(n / 5) * 5;
}

/** The fallback relationship: easy pace = 10K reference pace × 1.29. */
export function formulaEasyPaceSecPerKm(paceRef: number): number {
  return round5(paceRef * 1.29);
}

export interface EasyPaceSample {
  activityType: string | null;
  durationSeconds: number | null;
  avgHeartRate: number | null;
  avgPaceSecPerKm: number | null;
  /** Grade-adjusted pace — preferred when present, so hilly runs don't read as slow easy runs. */
  gapPaceSecPerKm: number | null;
  /** Session kind the activity was matched to; null when it's an unplanned ("hors plan") run. */
  plannedKind: SessionKind | null;
}

export interface EasyPaceEstimate {
  secPerKm: number;
  source: "runs" | "formula";
  /** Runs the fit rested on (0 when there weren't any usable ones). */
  runCount: number;
  /** HR the fit was read at; null for the formula. */
  targetBpm: number | null;
  /** Why the formula was kept, when it was. */
  fallbackReason: string | null;
}

/**
 * Which samples count as an easy/long run: outdoor running (treadmill pace is
 * unreliable), long enough, with HR and pace. A run matched to a planned
 * session counts only if that session was easy/long; an unplanned run counts
 * when its average HR stays below the top of Aérobie — easy running by effort.
 */
function isEasyRun(s: EasyPaceSample, zones: HeartRateZones): boolean {
  const type = (s.activityType ?? "").toLowerCase();
  if (!type.includes("running") || type === "treadmill_running") return false;
  if ((s.durationSeconds ?? 0) < MIN_RUN_SECONDS) return false;
  if (s.avgHeartRate == null || (s.gapPaceSecPerKm ?? s.avgPaceSecPerKm) == null) return false;
  if (s.plannedKind != null) return s.plannedKind === "easy" || s.plannedKind === "long";
  return s.avgHeartRate <= zones.aerobie.bpmMax;
}

export function estimateEasyPace(
  samples: EasyPaceSample[],
  zones: HeartRateZones,
  paceRef: number
): EasyPaceEstimate {
  const formula = (runCount: number, fallbackReason: string): EasyPaceEstimate => ({
    secPerKm: formulaEasyPaceSecPerKm(paceRef),
    source: "formula",
    runCount,
    targetBpm: null,
    fallbackReason,
  });

  const points = samples
    .filter((s) => isEasyRun(s, zones))
    .map((s) => ({ hr: s.avgHeartRate!, pace: (s.gapPaceSecPerKm ?? s.avgPaceSecPerKm)! }));
  if (points.length < EASY_PACE_MIN_RUNS) {
    return formula(points.length, `moins de ${EASY_PACE_MIN_RUNS} sorties faciles exploitables`);
  }

  const n = points.length;
  const meanHr = points.reduce((a, p) => a + p.hr, 0) / n;
  const meanPace = points.reduce((a, p) => a + p.pace, 0) / n;
  const sxx = points.reduce((a, p) => a + (p.hr - meanHr) ** 2, 0);
  const sxy = points.reduce((a, p) => a + (p.hr - meanHr) * (p.pace - meanPace), 0);
  if (sxx === 0) return formula(n, "FC trop homogène entre les sorties pour un ajustement");
  const slope = sxy / sxx;
  if (slope < SLOPE_RANGE.min || slope > SLOPE_RANGE.max) {
    return formula(n, "relation allure/FC peu plausible sur ces sorties");
  }

  const targetBpm = zones.facile.bpmMax - TARGET_BPM_BELOW_FACILE_TOP;
  const hrs = points.map((p) => p.hr);
  if (targetBpm < Math.min(...hrs) - MAX_EXTRAPOLATION_BPM || targetBpm > Math.max(...hrs) + MAX_EXTRAPOLATION_BPM) {
    return formula(n, "sorties trop éloignées de la zone Facile");
  }

  const pace = meanPace + slope * (targetBpm - meanHr);
  if (pace < paceRef * PACE_REF_RATIO_RANGE.min || pace > paceRef * PACE_REF_RATIO_RANGE.max) {
    return formula(n, "allure estimée hors de la plage plausible");
  }

  return { secPerKm: round5(pace), source: "runs", runCount: n, targetBpm, fallbackReason: null };
}
