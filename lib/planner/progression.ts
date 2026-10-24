// Progression engine (spec §3): 4-week blocks (1 week for Décharge), advancing
// on a fixed priority order — frequency suggestion, then quality-session
// volume, then re-anchoring the long run — never two at once. The long run is
// stored (longRunMinutes) rather than read live from the anchor (anchor.ts),
// so a single longer outing can't raise the prescription in the same block as
// another change: it moves only here, as priority 3.

import type { TrainingPhase } from "./types";
import { fullWeeksBetween } from "./dates";

export interface ProgressionState {
  /** Monday the progression cycle first started — only used for week-parity rotation, never reset. */
  cycleStartDate: Date;
  phase: TrainingPhase;
  /** Monday the current phase-block began — drives block-boundary detection. */
  blockStartDate: Date;
  /** 0-based; caps the quality-session volume templates in rules.ts. */
  qualityLevel: number;
  suggestedRunsPerWeek: 1 | 2 | 3;
  /** Prescribed long-run duration (min) — easy runs derive from it. Changes only via priority 3 / rollback. */
  longRunMinutes: number;
  /** longRunMinutes before the last priority-3 step, for a < 50% rollback; null when there's nothing to undo. */
  previousLongRunMinutes: number | null;
  lastChangeApplied: "frequency" | "quality" | "long_run" | null;
}

export const MAX_QUALITY_LEVEL = 6;

const BLOCK_WEEKS: Record<TrainingPhase, number> = {
  base: 4,
  developpement: 4,
  specifique: 4,
  decharge: 1,
};

const NEXT_PHASE: Record<TrainingPhase, TrainingPhase> = {
  base: "developpement",
  developpement: "specifique",
  specifique: "decharge",
  decharge: "base",
};

/** Priority 3 grows the long run by at most this much per step. */
const LONG_RUN_STEP_FACTOR = 1.1;

function round5(n: number): number {
  return Math.round(n / 5) * 5;
}

/**
 * Priority 3's next long run: min(anchor, current × 1.10) rounded to 5 min —
 * or null when that wouldn't lengthen it (the athlete hasn't yet run longer
 * than the current prescription, so there's no demonstrated capacity to
 * re-anchor on). A good block never shortens the long run.
 */
export function nextLongRunMinutes(currentMinutes: number, anchorMinutes: number): number | null {
  const next = round5(Math.min(anchorMinutes, currentMinutes * LONG_RUN_STEP_FACTOR));
  return next > currentMinutes ? next : null;
}

export function isBlockBoundary(state: ProgressionState, weekStart: Date): boolean {
  return fullWeeksBetween(state.blockStartDate, weekStart) >= BLOCK_WEEKS[state.phase];
}

export interface BlockEvaluationInput {
  state: ProgressionState;
  /** % of the completed block's planned sessions marked completed; null when there's nothing to measure. */
  consistencyScorePct: number | null;
  weekStart: Date;
  /** Longest run of the last 12 weeks (anchor.ts) — priority 3's ceiling. */
  longRunAnchorMinutes: number;
}

/**
 * Applies one block-boundary evaluation. consistencyScorePct is treated as
 * "repeat the block" (50-70% band) when null — no data isn't evidence of
 * either success or struggle.
 *
 * At >= 70%, exactly one variable advances: frequency until the 3-run cap;
 * then quality and the long run take turns — the long run (priority 3) only
 * once quality has advanced since its last step, as the spec requires "(1)
 * et (2) ont déjà progressé". When it's one's turn but it can't move (quality
 * maxed, or no longer run to re-anchor on), the other goes instead.
 */
export function evaluateBlockBoundary({
  state,
  consistencyScorePct,
  weekStart,
  longRunAnchorMinutes,
}: BlockEvaluationInput): ProgressionState {
  const score = consistencyScorePct ?? 60;

  if (score >= 70) {
    const next: ProgressionState = { ...state };
    const canRaiseQuality = state.qualityLevel < MAX_QUALITY_LEVEL;
    const longRun = nextLongRunMinutes(state.longRunMinutes, longRunAnchorMinutes);
    const raiseQuality = () => {
      next.qualityLevel += 1;
      next.lastChangeApplied = "quality";
    };
    const raiseLongRun = (minutes: number) => {
      next.previousLongRunMinutes = state.longRunMinutes;
      next.longRunMinutes = minutes;
      next.lastChangeApplied = "long_run";
    };

    if (state.suggestedRunsPerWeek < 3) {
      next.suggestedRunsPerWeek = (state.suggestedRunsPerWeek + 1) as 1 | 2 | 3;
      next.lastChangeApplied = "frequency";
    } else if (state.lastChangeApplied !== "quality" && canRaiseQuality) {
      raiseQuality();
    } else if (longRun !== null) {
      raiseLongRun(longRun);
    } else if (canRaiseQuality) {
      raiseQuality();
    } else {
      next.lastChangeApplied = null;
    }
    next.phase = NEXT_PHASE[state.phase];
    next.blockStartDate = weekStart;
    return next;
  }

  if (score >= 50) {
    // Repeat the block identically — only the block clock resets.
    return { ...state, blockStartDate: weekStart };
  }

  // < 50%: roll back the last change applied, and reset to Base.
  const rolled: ProgressionState = { ...state, blockStartDate: weekStart, lastChangeApplied: null, phase: "base" };
  if (state.lastChangeApplied === "frequency" && state.suggestedRunsPerWeek > 1) {
    rolled.suggestedRunsPerWeek = (state.suggestedRunsPerWeek - 1) as 1 | 2 | 3;
  } else if (state.lastChangeApplied === "quality" && state.qualityLevel > 0) {
    rolled.qualityLevel = state.qualityLevel - 1;
  } else if (state.lastChangeApplied === "long_run" && state.previousLongRunMinutes != null) {
    rolled.longRunMinutes = state.previousLongRunMinutes;
    rolled.previousLongRunMinutes = null;
  }
  return rolled;
}
