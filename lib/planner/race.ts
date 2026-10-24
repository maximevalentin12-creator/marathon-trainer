// Temporary race-preparation mode: a short bridge for races up to the half
// marathon, ahead of a full race-based planner. Pure — which week of a race
// block a given week is, and the peak long run. The sessions themselves are
// built in rules.ts (buildWeekPlan with PlannerInput.raceMode).
//
// Weeks run Monday-Sunday and are positioned against the race week:
//   > 10 km (up to 21.1): -2 peak, -1 reduction, 0 race, +1 recovery
//   <= 10 km:             -1 peak,                0 race, +1 recovery
// Above 21.1 km a race is stored but never activates race mode.

import type { RaceModeInput, RaceWeekPosition, SubjectiveSignal } from "./types";
import { addDays, toMonday } from "./dates";

export interface Race {
  id: string;
  name: string;
  raceDate: Date;
  distanceKm: number;
}

/** Longest distance race mode handles — the half marathon. */
export const RACE_MODE_MAX_DISTANCE_KM = 21.1;
/** At or below this distance the block has no reduction week, and a shorter peak. */
const SHORT_RACE_MAX_DISTANCE_KM = 10;

/** The peak long run's target range (min), before the 1.2× cap. */
const PEAK_LONG_RUN_RANGE: Record<"short" | "half", { min: number; max: number }> = {
  short: { min: 60, max: 70 },
  half: { min: 85, max: 90 },
};
/** The peak long run never exceeds the longest run of the last 12 weeks by more than this. */
const PEAK_LONG_RUN_CAP_FACTOR = 1.2;

export function raceModeSupported(distanceKm: number): boolean {
  return distanceKm <= RACE_MODE_MAX_DISTANCE_KM;
}

function isShortRace(distanceKm: number): boolean {
  return distanceKm <= SHORT_RACE_MAX_DISTANCE_KM;
}

/** The race this week belongs to: the earliest race whose recovery week hasn't ended before weekStart. */
export function raceForWeek(races: Race[], weekStart: Date): Race | null {
  const upcoming = races
    .filter((r) => addDays(toMonday(r.raceDate), 7) >= weekStart)
    .sort((a, b) => a.raceDate.getTime() - b.raceDate.getTime());
  return upcoming[0] ?? null;
}

/** Where weekStart (a Monday) sits relative to the race, or null outside the race block. */
export function raceWeekPosition(race: Race, weekStart: Date): RaceWeekPosition | null {
  if (!raceModeSupported(race.distanceKm)) return null;
  const offset = Math.round(
    (weekStart.getTime() - toMonday(race.raceDate).getTime()) / (7 * 86_400_000)
  );
  if (offset === 1) return "recovery";
  if (offset === 0) return "race";
  if (isShortRace(race.distanceKm)) return offset === -1 ? "peak" : null;
  if (offset === -1) return "reduction";
  if (offset === -2) return "peak";
  return null;
}

/**
 * The peak week's long run: the top of the distance's range, capped at 1.2×
 * the longest run of the last 12 weeks and rounded down to 5 min. With no run
 * in that window there's nothing to cap on, so the stored long run is used.
 */
export function peakLongRunMinutes(
  distanceKm: number,
  longestRecentRunMinutes: number,
  storedLongRunMinutes: number
): number {
  const range = PEAK_LONG_RUN_RANGE[isShortRace(distanceKm) ? "short" : "half"];
  const cap =
    longestRecentRunMinutes > 0
      ? Math.floor((longestRecentRunMinutes * PEAK_LONG_RUN_CAP_FACTOR) / 5) * 5
      : storedLongRunMinutes;
  return Math.max(20, Math.min(range.max, cap));
}

/** Race mode for weekStart, from the user's races — null for a normal week. */
export function raceModeForWeek(
  races: Race[],
  weekStart: Date,
  longestRecentRunMinutes: number,
  storedLongRunMinutes: number
): RaceModeInput | null {
  const race = raceForWeek(races, weekStart);
  if (!race) return null;
  const position = raceWeekPosition(race, weekStart);
  if (!position) return null;
  return {
    position,
    raceName: race.name,
    raceDate: race.raceDate,
    distanceKm: race.distanceKm,
    peakLongRunMinutes: peakLongRunMinutes(race.distanceKm, longestRecentRunMinutes, storedLongRunMinutes),
  };
}

/**
 * The progression block clock restarts after a race's recovery week: returns
 * the Monday after the most recent such week that ended on or before
 * weekStart, when it's later than the stored block start — else the stored
 * one. Only races that activated race mode count.
 */
export function blockStartAfterRaces(races: Race[], weekStart: Date, storedBlockStart: Date): Date {
  let result = storedBlockStart;
  for (const race of races) {
    if (!raceModeSupported(race.distanceKm)) continue;
    const afterRecovery = addDays(toMonday(race.raceDate), 14);
    if (afterRecovery <= weekStart && afterRecovery > result) result = afterRecovery;
  }
  return result;
}

/** Shown on the race card and the race session — the race itself is never downgraded. */
export const RACE_PAIN_WARNING =
  "Douleur signalée avant la course : ne prends le départ que si elle a disparu, et arrête-toi si elle revient.";
export const RACE_PAIN_WARNING_MIN_SCORE = 3;

/**
 * Whether any subjective entry in the 48 h before the race (the same window
 * as the downgrade rules: dated from two days before up to race day) reports
 * pain at or above the warning threshold.
 */
export function painReportedBeforeRace(entries: SubjectiveSignal[], raceDate: Date): boolean {
  return entries.some((e) => {
    const diffMs = raceDate.getTime() - e.entryDate.getTime();
    return e.painScore >= RACE_PAIN_WARNING_MIN_SCORE && diffMs >= 0 && diffMs <= 48 * 3600 * 1000;
  });
}

/** Whole days from `today` to the race, both UTC-midnight dates (0 on race day, negative once past) — the "J-n" countdown. */
export function daysUntilRace(raceDate: Date, today: Date): number {
  return Math.round((raceDate.getTime() - today.getTime()) / 86_400_000);
}
