// Resolves one week of the backward race plan (racePlan.ts) into what the week
// generator consumes: the plan week, the race mode for a race week, and the
// race-based paces. Pure — loading history and races is generateWeek.ts's job.

import { addDays, toMonday } from "./dates";
import type { Race } from "./race";
import {
  buildRacePlan,
  planWeekFor,
  LONG_RUN_DAYS_BEFORE_RACE,
  QUALITY_DAYS_BEFORE_RACE,
  type HistoryActivity,
  type PlanRace,
  type RacePlan,
  type RacePlanWeek,
} from "./racePlan";
import { latestRaceResult, trainingPacesFromRace, type TrainingPaces } from "./paces";
import type { RaceModeInput, RacePlanWeekInput, TrainingPhase } from "./types";

const MS_PER_DAY = 86_400_000;

export interface RacePlanWeekParams {
  races: Race[];
  /** Monday of the week being generated. */
  weekStart: Date;
  /** UTC-midnight today: the plan is laid out from this week's Monday. */
  today: Date;
  activities: HistoryActivity[];
  flaggedDates: Date[];
  easyPaceSecPerKm: number;
}

export interface ResolvedRacePlanWeek {
  goal: Race;
  plan: RacePlan;
  week: RacePlanWeek;
  input: RacePlanWeekInput;
  /** Set for a week holding a race (tune-up, solo test or the goal) — it uses the race-week template. */
  raceMode: RaceModeInput | null;
  /** Null until a race result exists. */
  paces: TrainingPaces | null;
}

function toPlanRace(r: Race): PlanRace {
  return { id: r.id, name: r.name, raceDate: r.raceDate, distanceKm: r.distanceKm, bibStatus: r.bibStatus ?? "confirmed" };
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

/** The goal race the week prepares for: the earliest goal race that hasn't passed its own week. */
export function activeGoalRace(races: Race[], weekStart: Date): Race | null {
  return (
    races
      .filter((r) => (r.kind ?? "goal") === "goal" && r.raceDate >= weekStart)
      .sort((a, b) => a.raceDate.getTime() - b.raceDate.getTime())[0] ?? null
  );
}

/** Where the week-generator's training phase labels land for each plan phase. */
export function trainingPhaseOf(week: RacePlanWeek): TrainingPhase {
  if (week.isDeload || week.phase === "taper" || week.phase === "race" || week.phase === "recovery") return "decharge";
  if (week.phase === "specific") return "specifique";
  if (week.phase === "development") return "developpement";
  return "base";
}

/**
 * The week after a goal race's week is a recovery week whatever the distance —
 * race.ts only knows that for races up to the half marathon.
 */
export function goalRecoveryMode(races: Race[], weekStart: Date): RaceModeInput | null {
  const goal = races.find(
    (r) => (r.kind ?? "goal") === "goal" && toMonday(r.raceDate).getTime() === addDays(weekStart, -7).getTime()
  );
  return goal
    ? { position: "recovery", raceName: goal.name, raceDate: goal.raceDate, distanceKm: goal.distanceKm, peakLongRunMinutes: 0 }
    : null;
}

/** Pace of the race-week reminders: marathon or half pace by goal distance; nothing for shorter goals. */
function reminderPace(goalKm: number, paces: TrainingPaces): number | undefined {
  if (goalKm >= 36) return paces.marathonPaceSecPerKm;
  if (goalKm >= 15) return paces.halfPaceSecPerKm;
  return undefined;
}

export function resolveRacePlanWeek(params: RacePlanWeekParams): ResolvedRacePlanWeek | null {
  const { races, weekStart, today, activities, flaggedDates, easyPaceSecPerKm } = params;
  const goal = activeGoalRace(races, weekStart);
  if (!goal) return null;

  const tuneUps = races.filter((r) => r.kind === "tune_up" && r.parentRaceId === goal.id && r.raceDate >= today);
  const lastRace =
    races
      .filter((r) => r.raceDate < today)
      .sort((a, b) => b.raceDate.getTime() - a.raceDate.getTime())
      .map((r) => ({ raceDate: r.raceDate, distanceKm: r.distanceKm }))[0] ?? null;

  const plan = buildRacePlan(toPlanRace(goal), tuneUps.map(toPlanRace), {
    today,
    activities,
    flaggedDates,
    lastRace,
    easyPaceSecPerKm,
  });
  const week = planWeekFor(plan, weekStart);
  if (!week) return null;

  const longestRunKm = activities.reduce((max, a) => Math.max(max, a.distanceKm), 0);
  const result = latestRaceResult(races, today);
  const paces = result ? trainingPacesFromRace(result, longestRunKm) : null;

  // A race early next week closes the week's tail: no quality in the 3 days before it, no long run in the 4 before.
  const nextWeekRaces = [goal, ...tuneUps].filter(
    (r) => r.raceDate >= addDays(weekStart, 7) && daysBetween(addDays(weekStart, 7), r.raceDate) <= LONG_RUN_DAYS_BEFORE_RACE
  );
  const untilDay = (daysBefore: number) =>
    nextWeekRaces.length
      ? Math.min(...nextWeekRaces.map((r) => daysBetween(weekStart, r.raceDate) - daysBefore - 1))
      : undefined;

  const input: RacePlanWeekInput = {
    phase: week.phase,
    targetKm: week.targetKm,
    longRunMin: week.longRunMin,
    keySession: week.keySession,
    isDeload: week.isDeload,
    longRunMpBlock: week.longRunMpBlock,
    qualityFromDay: week.qualityFromDay,
    qualityUntilDay: untilDay(QUALITY_DAYS_BEFORE_RACE),
    longRunUntilDay: untilDay(LONG_RUN_DAYS_BEFORE_RACE),
    qualityLevel: week.qualityLevel,
  };

  let raceMode: RaceModeInput | null = null;
  if (week.raceIds.length > 0) {
    const inWeek = [goal, ...tuneUps].filter((r) => week.raceIds.includes(r.id));
    const race = inWeek.find((r) => r.id === goal.id) ?? inWeek.sort((a, b) => a.raceDate.getTime() - b.raceDate.getTime())[0];
    raceMode = {
      position: "race",
      raceName: race.name,
      raceDate: race.raceDate,
      distanceKm: race.distanceKm,
      peakLongRunMinutes: 0,
      soloTest: race.bibStatus === "solo_test",
      raceWeekLongRunMinutes: week.longRunMin > 0 ? week.longRunMin : undefined,
      reminderPaceSecPerKm: race.id === goal.id && paces ? reminderPace(goal.distanceKm, paces) : undefined,
    };
  }

  return { goal, plan, week, input, raceMode, paces };
}
