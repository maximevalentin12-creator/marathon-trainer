// Race-time predictions and the training paces derived from them. Pure.
//
// Everything here is a heuristic, not a measurement: Riegel's formula is
// least reliable far from the source distance (a half-marathon result
// over-predicts a 5K and under-predicts a marathon for most runners), and the
// 1.03 marathon-pace margin and the threshold = mean(10K, half) rule are
// rules of thumb. The easy pace and HR zones stay what the athlete's own runs
// fit (easyPace.ts, zones.ts) — nothing here replaces them.

/** Riegel's fatigue exponent. */
export const RIEGEL_EXPONENT = 1.06;

/** Marathon pace is the predicted marathon pace × this until a long run of at least LONG_RUN_PROOF_KM is logged. */
export const MARATHON_PACE_SAFETY_FACTOR = 1.03;
export const LONG_RUN_PROOF_KM = 28;

export const RACE_DISTANCES_KM = { fiveK: 5, tenK: 10, half: 21.0975, marathon: 42.195 } as const;

export interface RaceResult {
  distanceKm: number;
  timeSeconds: number;
}

export interface RacePredictions {
  fiveKSeconds: number;
  tenKSeconds: number;
  halfSeconds: number;
  marathonSeconds: number;
}

export interface TrainingPaces {
  predictions: RacePredictions;
  /** Marathon pace (sec/km): prediction × 1.03 until a 28 km+ run is logged, then the plain prediction. */
  marathonPaceSecPerKm: number;
  /** Heuristic: mean of the predicted 10K and half-marathon paces. */
  thresholdPaceSecPerKm: number;
  /** Heuristic: the predicted 5K pace. */
  vo2maxPaceSecPerKm: number;
  /** The predicted half-marathon pace, for race-pace tempos in a half-marathon block. */
  halfPaceSecPerKm: number;
  /** True while the marathon pace still carries the 3 % margin. */
  marathonPaceHasMargin: boolean;
}

/** Riegel: t2 = t1 × (d2 / d1)^1.06. */
export function riegelSeconds(result: RaceResult, targetDistanceKm: number): number {
  return result.timeSeconds * Math.pow(targetDistanceKm / result.distanceKm, RIEGEL_EXPONENT);
}

export function predictRaceTimes(result: RaceResult): RacePredictions {
  return {
    fiveKSeconds: riegelSeconds(result, RACE_DISTANCES_KM.fiveK),
    tenKSeconds: riegelSeconds(result, RACE_DISTANCES_KM.tenK),
    halfSeconds: riegelSeconds(result, RACE_DISTANCES_KM.half),
    marathonSeconds: riegelSeconds(result, RACE_DISTANCES_KM.marathon),
  };
}

/**
 * Training paces from the most recent race result. `longestRunKm` is the
 * longest run logged so far: a marathon pace never confirmed by a 28 km+ run
 * keeps its margin.
 */
export function trainingPacesFromRace(result: RaceResult, longestRunKm: number): TrainingPaces {
  const predictions = predictRaceTimes(result);
  const marathonPace = predictions.marathonSeconds / RACE_DISTANCES_KM.marathon;
  const marathonPaceHasMargin = longestRunKm < LONG_RUN_PROOF_KM;
  const tenKPace = predictions.tenKSeconds / RACE_DISTANCES_KM.tenK;
  const halfPace = predictions.halfSeconds / RACE_DISTANCES_KM.half;
  return {
    predictions,
    marathonPaceSecPerKm: Math.round(marathonPace * (marathonPaceHasMargin ? MARATHON_PACE_SAFETY_FACTOR : 1)),
    thresholdPaceSecPerKm: Math.round((tenKPace + halfPace) / 2),
    vo2maxPaceSecPerKm: Math.round(predictions.fiveKSeconds / RACE_DISTANCES_KM.fiveK),
    halfPaceSecPerKm: Math.round(halfPace),
    marathonPaceHasMargin,
  };
}

/** The most recent result among races that have one, or null. */
export function latestRaceResult(
  races: Array<{ raceDate: Date; distanceKm: number; resultTimeSeconds?: number | null }>,
  asOf: Date
): (RaceResult & { raceDate: Date }) | null {
  const done = races
    .filter((r) => r.resultTimeSeconds != null && r.resultTimeSeconds > 0 && r.raceDate <= asOf)
    .sort((a, b) => b.raceDate.getTime() - a.raceDate.getTime())[0];
  return done ? { raceDate: done.raceDate, distanceKm: done.distanceKm, timeSeconds: done.resultTimeSeconds! } : null;
}
