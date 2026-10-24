// Tunables of the backward race planner (racePlan.ts). Heuristics, not
// measurements: change them here, nowhere else. "n" / "weeks to race" counts
// Monday-Sunday weeks back from race week (race week = 0).

export type DistanceClass = "marathon" | "half" | "short";

export interface MpBlockSpec {
  reps: number;
  kmEach: number;
}

export const RACE_PLAN_CONFIG = {
  // ── Volume ────────────────────────────────────────────────────────────
  /** Weekly training-km ceiling per goal distance. Never below the athlete's own baseline. */
  volumeCeilingKm: { marathon: 65, half: 50, short: 42 } as Record<DistanceClass, number>,
  /** A load week never exceeds the previous load week by more than this. */
  maxWeeklyIncrease: 0.1,
  /** Deload weeks (every 4th week back from the race) run at this share of the previous load week. */
  deloadShare: 0.75,
  /** No deload before this many load weeks have been built after recovery. */
  minLoadWeeksBeforeDeload: 2,

  // ── Taper ─────────────────────────────────────────────────────────────
  /**
   * The marathon taper is 2 weeks and race week is the 2nd of them: only week -1
   * is a separate taper week. Half and shorter: a taper week, then race week.
   */
  raceWeekCountsAsTaper: { marathon: true, half: false, short: false } as Record<DistanceClass, boolean>,
  /** Taper weeks' share of the peak week's km, by weeks to race. */
  taperVolumeShare: {
    marathon: { 1: 0.7 },
    half: { 1: 0.7 },
    short: { 1: 0.7 },
  } as Record<DistanceClass, Record<number, number>>,
  /** Goal race week's TRAINING km (the race itself not counted) as a share of the peak week's — never above 0.5. */
  raceWeekVolumeShare: { marathon: 0.45, half: 0.45, short: 0.45 } as Record<DistanceClass, number>,
  /**
   * The marathon's week -2 is a reduced week: at most this share of the peak km, with the long run
   * (and its MP block) as its only quality — midweek is easy + strides.
   */
  reducedWeek: { marathon: { weeksToRace: 2, shareOfPeak: 0.85 } } as Partial<
    Record<DistanceClass, { weeksToRace: number; shareOfPeak: number }>
  >,
  /** Taper weeks' long run as a share of the peak long run, by weeks to race. */
  taperLongRunShare: { 1: 0.5 } as Record<number, number>,

  // ── Phase lengths (weeks), counted back from the race; base takes the rest ──
  phaseWeeks: {
    marathon: { taper: 2, specific: 5, development: 6 },
    half: { taper: 1, specific: 4, development: 4 },
    short: { taper: 1, specific: 3, development: 3 },
  } as Record<DistanceClass, { taper: number; specific: number; development: number }>,
  /** Lead time (weeks) under which the plan warns and compresses base first. */
  minLeadWeeks: { marathon: 12, half: 8, short: 6 } as Record<DistanceClass, number>,

  // ── Long run ──────────────────────────────────────────────────────────
  longRunStepMin: 10,
  longRunCapMin: 180,
  longRunCapKm: 32,
  /** Peak long run per goal distance (minutes), under the global caps above. Marathon: ~2h45. */
  longRunPeakMin: { marathon: 165, half: 135, short: 105 } as Record<DistanceClass, number>,
  /** Weeks to race at which the long run peaks. The marathon's last peak is week -2. */
  longRunPeakWeeks: { marathon: [5, 2], half: [5, 3], short: [5, 3] } as Record<DistanceClass, number[]>,
  /** A tune-up under a half marathon keeps its long run at this share. */
  tuneUpLongRunShare: 0.6,

  /** Long run's hard cap as a share of the week's km, by phase. When it binds the long run shrinks, never the week's km. */
  longRunMaxShareOfWeek: { base: 0.4, development: 0.4, specific: 0.45 } as Record<"base" | "development" | "specific", number>,
  /** After recovery weeks the long run resumes at this share of the anchor (the longest non-race run of 12 weeks). */
  resumeLongRunShare: 0.9,

  // ── Race weeks (volumes INCLUDE the race distance) ────────────────────
  /** A tune-up week's km (race included) as a share of the previous full week: under a half / a half or longer. */
  tuneUpWeekShare: { short: 0.85, half: 0.7 },
  /** The week after a half or longer: at most this share of the last full week, all easy. */
  postRaceWeekMaxShare: 0.7,

  // ── After a race ──────────────────────────────────────────────────────
  /** ceil(race km / 3) easy days after any race before quality — MP blocks count as quality. */
  easyDaysPerKm: 1 / 3,
  /** After a race of at least this many km, the next week is easy only... */
  postRaceMinKm: 21,
  /** ...with one easy long run (no MP), from this many days after the race, at most this long. */
  postRaceLongRunFromDay: 6,
  postRaceLongRunMaxMin: 120,

  // ── Marathon-pace blocks in the long run (marathon, specific phase) ───
  mpBlock: {
    /**
     * Total km at marathon pace by weeks to race. A week that isn't listed, is a deload,
     * holds a race or falls inside a post-race easy window gets no block. The earlier peak
     * is week -5 (12 km); the last one, week -2 (14 km).
     */
    kmByWeeksToRace: { 6: 6, 5: 12, 3: 10, 2: 14 } as Record<number, number>,
    /** Each total km as reps × km. */
    blocks: {
      6: { reps: 2, kmEach: 3 },
      8: { reps: 2, kmEach: 4 },
      10: { reps: 2, kmEach: 5 },
      12: { reps: 2, kmEach: 6 },
      14: { reps: 2, kmEach: 7 },
      16: { reps: 2, kmEach: 8 },
    } as Record<number, MpBlockSpec>,
    /** The plan warns when no block reaches this many km. */
    targetPeakKm: 14,
  },

  // ── Recovery after the last race ──────────────────────────────────────
  /** Share of baseline km for the first and second recovery weeks. */
  recoveryVolumeShare: [0.5, 0.7],
} as const;
