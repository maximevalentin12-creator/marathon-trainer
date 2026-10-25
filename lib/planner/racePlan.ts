// Backward race planner: given a goal race (and the tune-up races before it),
// lays out every week from the current one to race week. Pure — history in,
// weeks out; the DB loading lives in lib/planner/generateWeek.ts.
//
// Weeks run Monday-Sunday. Offset n counts weeks back from race week:
//   n = 0 race week, n = 1 the week before, ...
// Phases are assigned backward from the race (taper, specific, development,
// base = the rest), so a short lead time compresses base first.
//
// targetKm: a tune-up week's volume INCLUDES the race distance (it is planned as a share of the previous
// full week); the goal race week's is its training km only — the race itself would put the week over
// the 50 %-of-peak cap on its own.

import { addDays, toMonday } from "./dates";
import { RACE_PLAN_CONFIG as CFG, type DistanceClass } from "./config";

export type RacePhase = "recovery" | "base" | "development" | "specific" | "taper" | "race";

/**
 * The week's key session — what replaces or defines the quality slot:
 * threshold / vo2max: the usual sessions; mp_tempo / race_pace: a continuous
 * tempo at marathon / half-marathon pace; mp_reminder: easy run with short
 * race-pace reminders and strides (the taper's only "quality"); race: a race
 * this week; time_trial / long_tempo: a solo test standing in for a race;
 * strides: easy running with strides, the long run being the week's only quality (marathon week -2);
 * none: easy running only (recovery, deload, or quality not yet allowed).
 */
export type RaceKeySession =
  | "none"
  | "threshold"
  | "vo2max"
  | "mp_tempo"
  | "race_pace"
  | "mp_reminder"
  | "race"
  | "time_trial"
  | "long_tempo"
  | "strides";

export interface PlanRace {
  id: string;
  name: string;
  raceDate: Date;
  distanceKm: number;
  bibStatus: "confirmed" | "pending" | "solo_test";
}

export interface HistoryActivity {
  startTime: Date;
  distanceKm: number;
  durationMinutes: number;
  activityType: string | null;
  /** A race (matched to a races row, or flagged as one by Garmin): never counts toward the long-run anchor. */
  isRace?: boolean;
}

export interface RacePlanHistory {
  /** UTC-midnight date the plan starts from (its week's Monday is week 0). */
  today: Date;
  /** Garmin activities — at least the last 12 weeks. */
  activities: HistoryActivity[];
  /** Days with a sick/pain flag; a week holding one is left out of the baseline volume. */
  flaggedDates?: Date[];
  /** The most recent finished race, for the post-race recovery rules. */
  lastRace?: { raceDate: Date; distanceKm: number } | null;
  /** Easy pace (sec/km), to turn long-run minutes into km. */
  easyPaceSecPerKm?: number;
  /** Marathon pace (sec/km) — lets the plan check that each MP block fits its long run. */
  marathonPaceSecPerKm?: number;
}

/** Marathon-pace block inside a long run: `reps` × `kmEach` km. */
export interface MpBlock {
  reps: number;
  kmEach: number;
  /** One continuous MP segment closing the long run (development phase). */
  finish?: boolean;
}

export interface RacePlanWeek {
  weekStart: Date;
  phase: RacePhase;
  /** Planned km — race included for a tune-up week, training only for the goal race week. */
  targetKm: number;
  /** Km of the tune-up races inside targetKm (0 when none). */
  raceKm: number;
  /** Minutes; 0 when the week has no long run. */
  longRunMin: number;
  keySession: RaceKeySession;
  raceIds: string[];
  isDeload: boolean;
  notes: string[];
  /** Weeks before race week (0 = race week). */
  weeksToRace: number;
  /** Progression level for the threshold/vo2max volume tables (0-6). */
  qualityLevel: number;
  /** MP blocks in the long run (marathon specific phase); null otherwise. */
  longRunMpBlock: MpBlock | null;
  /** First day (0 = Monday) a quality session may land on — after a race's easy days; 0 = no restriction. */
  qualityFromDay: number;
  /** First day (0 = Monday) the long run may land on — the week after a half or longer; 0 = no restriction. */
  longRunFromDay: number;
}

export interface RacePlan {
  weeks: RacePlanWeek[];
  warnings: string[];
  baselineKm: number;
  longRunAnchorMin: number;
  peakKm: number;
}

// ─── Constants (the tunable ones live in config.ts) ────────────────────────

/** Deload weeks and the other numbers below come from config.ts; these names keep the code short. */
const DELOAD_FACTOR = CFG.deloadShare;

/** The planner puts the long run on Saturday (rules.ts assignDaysToSlots). */
const LONG_RUN_DAY = 5;
/** Minutes of easy running in a race week's template (rules.ts: a 30 min run, a 20 min run + strides, reminders). */
const RACE_WEEK_EASY_MINUTES = 60;
const DEFAULT_EASY_PACE_SEC_PER_KM = 375;
/** No long run in the 4 days before a race; no quality in the 3 days before. */
export const LONG_RUN_DAYS_BEFORE_RACE = 4;
export const QUALITY_DAYS_BEFORE_RACE = 3;
const DEFAULT_BASELINE_KM = 20;
const MS_PER_DAY = 86_400_000;

// ─── Helpers ───────────────────────────────────────────────────────────────

function distanceClass(km: number): DistanceClass {
  if (km >= 36) return "marathon";
  if (km >= 15) return "half";
  return "short";
}

function isRunning(type: string | null): boolean {
  return !type || type.toLowerCase().includes("running");
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round5(n: number): number {
  return Math.round(n / 5) * 5;
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

/** Day (UTC midnight) from which quality is allowed again after a race: raceDate + ceil(km/3) easy days + 1. */
function qualityAllowedFrom(raceDate: Date, distanceKm: number): Date {
  return addDays(raceDate, Math.ceil(distanceKm * CFG.easyDaysPerKm) + 1);
}

/** Baseline: median weekly running km of the 4 full weeks before the plan starts, flagged weeks excluded. */
function baselineWeeklyKm(history: RacePlanHistory, planStart: Date): number {
  const weeks: number[] = [];
  for (let k = 1; k <= 4; k++) {
    const start = addDays(planStart, -7 * k);
    const end = addDays(start, 7);
    const flagged = (history.flaggedDates ?? []).some((d) => d >= start && d < end);
    const km = history.activities
      .filter((a) => a.startTime >= start && a.startTime < end && isRunning(a.activityType))
      .reduce((sum, a) => sum + a.distanceKm, 0);
    weeks.push(flagged ? -1 : km);
  }
  const usable = weeks.filter((w) => w >= 0);
  // Fewer than two unflagged weeks is too thin a sample: fall back to all four.
  return median(usable.length >= 2 ? usable : weeks.map((w) => Math.max(0, w)));
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Shrinks an MP block to at most `maxKm` total: reps blocks go down to whole-km reps (min 2 km each),
 * a finish segment down to its km (min 2). Null when even the smallest doesn't fit.
 */
function fitMpBlock(block: MpBlock, maxKm: number): MpBlock | null {
  if (block.finish) return maxKm >= 2 ? { ...block, kmEach: Math.min(block.kmEach, maxKm) } : null;
  const kmEach = Math.min(block.kmEach, Math.floor(maxKm / block.reps));
  return kmEach >= 2 ? { ...block, kmEach } : null;
}

/** Longest NON-race run (min) of the 12 weeks before today, floored to 5 min, at least 30 — the long-run anchor. */
function longRunAnchorMin(history: RacePlanHistory): number {
  const cutoff = addDays(history.today, -84);
  const longest = history.activities
    .filter((a) => a.startTime >= cutoff && isRunning(a.activityType) && !a.isRace)
    .reduce((max, a) => Math.max(max, a.durationMinutes), 0);
  return longest === 0 ? 30 : Math.max(30, Math.floor(longest / 5) * 5);
}

// ─── The planner ───────────────────────────────────────────────────────────

export function buildRacePlan(goalRace: PlanRace, tuneUps: PlanRace[], history: RacePlanHistory): RacePlan {
  const warnings: string[] = [];
  const klass = distanceClass(goalRace.distanceKm);
  const planStart = toMonday(history.today);
  const raceWeekStart = toMonday(goalRace.raceDate);
  const weekCount = daysBetween(planStart, raceWeekStart) / 7 + 1;

  if (goalRace.raceDate < history.today || weekCount < 1) {
    return { weeks: [], warnings: ["La course objectif est passée."], baselineKm: 0, longRunAnchorMin: 0, peakKm: 0 };
  }

  const leadWeeks = Math.ceil(daysBetween(history.today, goalRace.raceDate) / 7);
  if (leadWeeks < CFG.minLeadWeeks[klass]) {
    warnings.push(
      `Préparation courte : ${leadWeeks} semaines avant la course, ${CFG.minLeadWeeks[klass]} recommandées. ` +
        "La base est raccourcie en premier."
    );
  }

  const easyPace = history.easyPaceSecPerKm ?? DEFAULT_EASY_PACE_SEC_PER_KM;
  const baselineRaw = baselineWeeklyKm(history, planStart);
  if (baselineRaw <= 0) warnings.push(`Aucun volume récent trouvé : base de ${DEFAULT_BASELINE_KM} km par défaut.`);
  const baseline = baselineRaw > 0 ? baselineRaw : DEFAULT_BASELINE_KM;
  const anchor = longRunAnchorMin(history);

  // Recovery after the last race, when it ended less than 14 days before the plan starts.
  let recoveryWeeks = 0;
  const last = history.lastRace;
  if (last) {
    const since = daysBetween(last.raceDate, planStart);
    if (since >= 0 && since < 14) {
      const wanted = last.distanceKm >= 21 ? 2 : 1;
      recoveryWeeks = Math.max(0, wanted - Math.floor(since / 7));
    }
  }

  // Skeleton: phase, deload, races per week.
  const lengths = CFG.phaseWeeks[klass];
  // The marathon's race week is the 2nd taper week: only the weeks before it are "taper" weeks.
  const taperWeeks = lengths.taper - (CFG.raceWeekCountsAsTaper[klass] ? 1 : 0);
  const goalSet = [goalRace, ...tuneUps];
  const weeks: RacePlanWeek[] = Array.from({ length: weekCount }, (_, i) => {
    const n = weekCount - 1 - i;
    const weekStart = addDays(planStart, 7 * i);
    let phase: RacePhase;
    if (n === 0) phase = "race";
    else if (n <= taperWeeks) phase = "taper";
    else if (n <= taperWeeks + lengths.specific) phase = "specific";
    else if (n <= taperWeeks + lengths.specific + lengths.development) phase = "development";
    else phase = "base";
    if (i < recoveryWeeks && n > 0) phase = "recovery";
    // Every 4th week back from the race — but never before two load weeks have been built after recovery.
    const isDeload = n > 0 && n % 4 === 0 && phase !== "recovery" && i - recoveryWeeks >= CFG.minLoadWeeksBeforeDeload;
    return {
      weekStart,
      phase,
      targetKm: 0,
      raceKm: 0,
      longRunMin: 0,
      keySession: "none",
      raceIds: goalSet
        .filter((r) => toMonday(r.raceDate).getTime() === weekStart.getTime() && r.raceDate >= history.today)
        .map((r) => r.id),
      isDeload,
      notes: [],
      weeksToRace: n,
      qualityLevel: 0,
      longRunMpBlock: null,
      qualityFromDay: 0,
      longRunFromDay: 0,
    };
  });

  const reduced = CFG.reducedWeek[klass];
  const isReduced = (w: RacePlanWeek) =>
    !!reduced && w.weeksToRace === reduced.weeksToRace && w.phase !== "recovery" && w.phase !== "race";
  const isLoad = (w: RacePlanWeek) =>
    !["recovery", "taper", "race"].includes(w.phase) && !w.isDeload && !isReduced(w);
  const raceById = new Map(goalSet.map((r) => [r.id, r]));
  const tuneUpsIn = (w: RacePlanWeek) =>
    w.raceIds.filter((id) => id !== goalRace.id).map((id) => raceById.get(id)!);

  // ── After any race: easy days before quality, and the week-after rules ──
  // ceil(km / 3) easy days come before quality: a week that starts inside that window may only hold
  // quality from qualityFromDay on. The week after a half or longer is easy only (volume capped below),
  // with one easy long run from day 6 — it applies when the week's long run (Saturday) falls within 6
  // days after the race.
  const finishedRaces: Array<{ raceDate: Date; distanceKm: number }> = [...goalSet];
  if (last) finishedRaces.push(last);
  const afterHalf = new Map<RacePlanWeek, { distanceKm: number; fromDay: number }>();
  for (const w of weeks) {
    const from = Math.max(
      0,
      ...finishedRaces
        .filter((r) => r.raceDate < w.weekStart)
        .map((r) => daysBetween(w.weekStart, qualityAllowedFrom(r.raceDate, r.distanceKm)))
    );
    w.qualityFromDay = Math.min(7, from);
    const longDay = addDays(w.weekStart, LONG_RUN_DAY);
    const recent = finishedRaces
      .filter(
        (r) =>
          r.distanceKm >= CFG.postRaceMinKm &&
          r.raceDate < w.weekStart &&
          daysBetween(r.raceDate, longDay) <= CFG.postRaceLongRunFromDay
      )
      .sort((a, b) => b.raceDate.getTime() - a.raceDate.getTime())[0];
    if (recent && w.phase !== "recovery") {
      const fromDay = daysBetween(w.weekStart, addDays(recent.raceDate, CFG.postRaceLongRunFromDay));
      w.longRunFromDay = Math.max(0, fromDay);
      afterHalf.set(w, { distanceKm: recent.distanceKm, fromDay });
    }
  }

  // ── Volume: ramp from the baseline to the ceiling, ≤ +10 %/week, deload at 75 % ──
  const ceiling = Math.max(CFG.volumeCeilingKm[klass], baseline);
  const loadWeeks = weeks.filter(isLoad);
  let lastLoadKm = baseline;
  let loadIndex = 0;
  for (const w of weeks) {
    if (w.phase === "recovery") {
      const idx = weeks.filter((x) => x.phase === "recovery").indexOf(w);
      w.targetKm = Math.round(baseline * CFG.recoveryVolumeShare[Math.min(idx, CFG.recoveryVolumeShare.length - 1)]);
    } else if (w.isDeload) {
      w.targetKm = Math.round(lastLoadKm * DELOAD_FACTOR);
    } else if (isLoad(w)) {
      const t = loadWeeks.length > 1 ? loadIndex / (loadWeeks.length - 1) : 1;
      const desired = baseline + (ceiling - baseline) * t;
      const capped = loadIndex === 0 ? baseline : Math.min(desired, lastLoadKm * (1 + CFG.maxWeeklyIncrease));
      lastLoadKm = Math.min(ceiling, capped);
      w.targetKm = Math.round(lastLoadKm);
      w.qualityLevel = Math.min(6, Math.floor(loadIndex / 2));
      loadIndex++;
    }
  }

  // A race week, and the week after a half or longer, are planned as a share of the last full week.
  // Race weeks include the race distance (never below the race plus a couple of short runs).
  const raceWeekEasyKm = Math.round((RACE_WEEK_EASY_MINUTES * 60) / easyPace);
  let lastFullKm = baseline;
  for (const w of weeks) {
    const tune = tuneUpsIn(w);
    if (w.phase === "race") continue;
    if (tune.length > 0) {
      const raceKm = tune.reduce((sum, r) => sum + r.distanceKm, 0);
      const share = tune.some((r) => r.distanceKm >= CFG.postRaceMinKm) ? CFG.tuneUpWeekShare.half : CFG.tuneUpWeekShare.short;
      w.raceKm = Math.round(raceKm * 10) / 10;
      w.targetKm = Math.round(Math.max(lastFullKm * share, raceKm + raceWeekEasyKm));
      w.notes.push(
        `Volume de la semaine, course incluse (${w.raceKm} km) : ≈ ${Math.round(share * 100)} % de la dernière semaine pleine (${Math.round(lastFullKm)} km).`
      );
    } else if (afterHalf.has(w)) {
      const cap = Math.round(lastFullKm * CFG.postRaceWeekMaxShare);
      if (w.targetKm > cap) w.targetKm = cap;
      w.notes.push(`Semaine après la course : ≤ ${Math.round(CFG.postRaceWeekMaxShare * 100)} % de la dernière semaine pleine (${Math.round(lastFullKm)} km).`);
    } else if (isLoad(w)) {
      lastFullKm = w.targetKm;
    }
  }
  const peakKm = Math.max(
    0,
    ...weeks.filter((w) => isLoad(w) && w.raceIds.length === 0 && !afterHalf.has(w)).map((w) => w.targetKm)
  );

  for (const w of weeks) {
    const n = w.weeksToRace;
    if (w.phase === "race") {
      w.targetKm = Math.min(Math.round(peakKm * CFG.raceWeekVolumeShare[klass]), raceWeekEasyKm);
    } else if (w.phase === "taper") {
      w.targetKm = Math.round(peakKm * (CFG.taperVolumeShare[klass][n] ?? 0.7));
    } else if (isReduced(w)) {
      w.targetKm = Math.round(peakKm * reduced!.shareOfPeak);
    }
  }

  // ── Long run: anchor → peak (at 5 and 3 weeks out), +10 min per load week at most ──
  // After recovery weeks the long run resumes at 90 % of the anchor.
  const peakWeeks = CFG.longRunPeakWeeks[klass];
  const startLong = recoveryWeeks > 0 ? round5(anchor * CFG.resumeLongRunShare) : anchor;
  const peakLongMin = Math.min(
    CFG.longRunCapMin,
    CFG.longRunPeakMin[klass],
    Math.floor((CFG.longRunCapKm * easyPace) / 60 / 5) * 5
  );
  const rampWeeks = weeks.filter((w) => isLoad(w) && w.weeksToRace >= peakWeeks[0]);
  const reachable = startLong + CFG.longRunStepMin * Math.max(0, rampWeeks.length - 1);
  const peakLong = Math.max(startLong, Math.min(peakLongMin, reachable));
  let lastLoadLong = startLong;
  let rampIndex = 0;
  for (const w of weeks) {
    const n = w.weeksToRace;
    if (w.phase === "recovery") {
      const first = weeks.findIndex((x) => x.phase === "recovery") === weeks.indexOf(w);
      w.longRunMin = first ? 0 : Math.min(60, round5(anchor * 0.5));
    } else if (w.phase === "taper") {
      w.longRunMin = round5(peakLong * (CFG.taperLongRunShare[n] ?? 0.5));
    } else if (w.phase === "race") {
      w.longRunMin = 0;
    } else if (w.isDeload) {
      w.longRunMin = round5(lastLoadLong * DELOAD_FACTOR);
    } else if (peakWeeks.includes(n)) {
      w.longRunMin = lastLoadLong = peakLong;
    } else if (n > peakWeeks[0]) {
      const t = rampWeeks.length > 1 ? rampIndex / (rampWeeks.length - 1) : 1;
      w.longRunMin = lastLoadLong = round5(startLong + (peakLong - startLong) * t);
      rampIndex++;
    } else {
      w.longRunMin = lastLoadLong; // between the peaks, if the layout leaves a load week there
    }
  }

  // The week after a half or longer: one easy long run, capped, from day 6 after the race — or none.
  for (const [w, info] of Array.from(afterHalf.entries())) {
    if (w.longRunMin <= 0) continue;
    if (info.fromDay > 6) {
      w.longRunMin = 0;
    } else {
      w.longRunMin = Math.min(w.longRunMin, CFG.postRaceLongRunMaxMin);
      w.notes.push(
        `Footings faciles uniquement après une course de ${info.distanceKm} km ; une seule sortie longue facile (≤ ${CFG.postRaceLongRunMaxMin / 60} h) à partir du jour ${CFG.postRaceLongRunFromDay} après la course.`
      );
    }
  }

  // ── Races: they replace the quality (and the long run from the half up) ──
  for (const w of weeks) {
    for (const id of w.raceIds) {
      const r = raceById.get(id)!;
      const isGoal = r.id === goalRace.id;
      if (isGoal) {
        w.keySession = "race";
        w.notes.push(
          `Semaine de course : ${r.name} (${r.distanceKm} km), le ${r.raceDate.toISOString().slice(0, 10)}. Volume = footings seuls, course non comptée.`
        );
        continue;
      }
      if (r.bibStatus === "solo_test") {
        w.keySession = r.distanceKm <= 12 ? "time_trial" : "long_tempo";
        w.notes.push(
          r.distanceKm <= 12
            ? `${r.name} : test chronométré en solo sur ${r.distanceKm} km à la place de la séance de qualité.`
            : `${r.name} : long tempo en solo à la place de la séance de qualité.`
        );
      } else {
        w.keySession = "race";
        w.notes.push(
          `${r.name} (${r.distanceKm} km) remplace la séance de qualité` +
            (r.bibStatus === "pending" ? " — dossard pas encore confirmé." : ".")
        );
      }
      // From the half the race replaces the long run. Below that it stays, but never in the 4 days
      // before the race — and with no day left before that window it goes.
      const raceDay = daysBetween(w.weekStart, r.raceDate);
      if (r.distanceKm >= 21) {
        w.longRunMin = 0;
        w.notes.push("Pas de sortie longue : la course la remplace.");
      } else if (raceDay - LONG_RUN_DAYS_BEFORE_RACE < 0) {
        w.longRunMin = 0;
        w.notes.push("Pas de sortie longue : la course tombe trop tôt dans la semaine (rien dans les 4 jours avant).");
      } else {
        w.longRunMin = round5(w.longRunMin * CFG.tuneUpLongRunShare);
        w.notes.push(
          `Sortie longue allégée (${Math.round(CFG.tuneUpLongRunShare * 100)} %), au plus tard ${LONG_RUN_DAYS_BEFORE_RACE} jours avant la course, jamais après.`
        );
      }
    }
  }

  // ── Hard cap: long run ≤ 40 % of the week's km (45 % in specific). It shrinks the long run, never the week ──
  for (const w of weeks) {
    if ((w.phase !== "base" && w.phase !== "development" && w.phase !== "specific") || w.longRunMin <= 0 || w.targetKm <= 0) continue;
    const share = CFG.longRunMaxShareOfWeek[w.phase];
    const capMin = Math.max(20, Math.floor(((share * w.targetKm * easyPace) / 60) / 5) * 5);
    if (w.longRunMin > capMin) {
      w.longRunMin = capMin;
      w.notes.push(`Sortie longue limitée à ${Math.round(share * 100)} % du volume de la semaine (${w.targetKm} km).`);
    }
  }

  // ── Floors win over the cap: long run ≥ 60 / 90 / 120 min (base / development / specific) ──
  // Tune-up, recovery, taper and race weeks are excepted. A floor that pushes a week's minimum running
  // past its planned km is reported, never cut.
  const runs = CFG.assumedRunsPerWeek;
  const easyFloorKm = (CFG.easyRunFloorMin * 60) / easyPace;
  const overFloors: string[] = [];
  for (const w of weeks) {
    if ((w.phase !== "base" && w.phase !== "development" && w.phase !== "specific") || w.raceIds.length > 0 || w.longRunMin <= 0) continue;
    const floor = CFG.longRunFloorMin[w.phase];
    if (w.longRunMin < floor) {
      w.longRunMin = floor;
      w.notes.push(`Sortie longue relevée au plancher de ${floor} min (${w.phase === "base" ? "base" : w.phase === "development" ? "développement" : "spécifique"}).`);
    }
    const minimumKm = (w.longRunMin * 60) / easyPace + (runs - 1) * easyFloorKm;
    if (minimumKm > w.targetKm + 0.5) overFloors.push(`${isoDay(w.weekStart)} (${Math.round(minimumKm)} km pour ${w.targetKm} prévus)`);
  }
  if (overFloors.length > 0) {
    warnings.push(
      `Les planchers (sortie longue, footings ≥ ${CFG.easyRunFloorMin} min sur ${runs} sorties) dépassent le volume prévu ${overFloors.length} semaine(s) : ` +
        `${overFloors.join(", ")}. Le volume n'est pas réduit.`
    );
  }

  // ── Quality session per week ──
  let qualityCount = 0;
  for (const w of weeks) {
    const n = w.weeksToRace;
    if (w.keySession !== "none") continue; // race week or test already set
    if (w.phase === "recovery") {
      w.notes.push("Récupération après la dernière course : footings faciles uniquement, pas de qualité.");
      continue;
    }
    if (w.phase === "race") continue;
    if (isReduced(w) && !w.isDeload) {
      // Week -2: the long run (with its MP block) is the only quality — midweek is easy + strides.
      w.keySession = "strides";
      w.notes.push(
        `Semaine réduite (≤ ${Math.round(reduced!.shareOfPeak * 100)} % du pic) : la sortie longue est la seule qualité, le reste en footings faciles avec lignes droites.`
      );
      continue;
    }
    if (w.phase === "taper") {
      w.keySession = "mp_reminder";
      w.notes.push(
        (klass === "marathon"
          ? "Affûtage : footing avec quelques rappels courts à allure marathon + lignes droites. Rien de dur."
          : "Affûtage : footing avec quelques rappels courts à allure course + lignes droites. Rien de dur.") +
          ` ≈ ${Math.round((CFG.taperVolumeShare[klass][n] ?? 0.7) * 100)} % du pic de volume.`
      );
      continue;
    }
    if (w.isDeload) {
      w.notes.push("Semaine allégée (75 %) : pas de séance de qualité.");
      continue;
    }
    if (w.qualityFromDay >= 5) {
      w.notes.push("Qualité repoussée : trop peu de jours faciles écoulés depuis la dernière course.");
      continue;
    }
    const alt = qualityCount % 2 === 1;
    qualityCount++;
    if (!alt) w.keySession = "threshold";
    else if (w.phase === "specific" && klass === "marathon") w.keySession = "mp_tempo";
    else if (w.phase === "specific" && klass === "half") w.keySession = "race_pace";
    else w.keySession = "vo2max";
    if (w.qualityFromDay > 0) {
      w.notes.push("Qualité au plus tôt en fin de semaine : jours faciles après la dernière course.");
    }
  }

  // ── Marathon-pace work in the long run (marathon) ──
  // Specific phase: blocks (12 km at -5, 14 km at -2). Development phase, from 10 weeks out: the non-deload
  // long run finishes with one MP segment (3 → 5 → 6 km). They count as quality: a week holding a race, a
  // deload, or inside a post-race easy window gets none.
  if (klass === "marathon") {
    const ladder = CFG.mpBlock.kmByWeeksToRace;
    const devLadder = CFG.mpBlock.developmentKmByWeeksToRace;
    for (const w of weeks) {
      const dev = w.phase === "development";
      const km = dev ? devLadder[w.weeksToRace] : w.phase === "specific" ? ladder[w.weeksToRace] : undefined;
      if (km === undefined || w.isDeload || w.raceIds.length > 0 || w.longRunMin <= 0) continue;
      if (w.longRunFromDay > 0 || w.qualityFromDay > LONG_RUN_DAY) continue;
      w.longRunMpBlock = dev ? { reps: 1, kmEach: km, finish: true } : CFG.mpBlock.blocks[km];
    }

    // Feasibility: MP km × MP pace + 30 min easy must fit in the long run — else the block shrinks.
    const mpPace = history.marathonPaceSecPerKm;
    if (mpPace) {
      for (const w of weeks) {
        const b = w.longRunMpBlock;
        if (!b) continue;
        const total = b.reps * b.kmEach;
        const maxKm = Math.floor(((w.longRunMin - CFG.mpBlock.minEasyMin) * 60) / mpPace);
        if (total <= maxKm) continue;
        const fitted = fitMpBlock(b, maxKm);
        warnings.push(
          `${isoDay(w.weekStart)} : ${total} km à allure marathon + ${CFG.mpBlock.minEasyMin} min faciles ne tiennent pas dans ${w.longRunMin} min — ` +
            (fitted ? `bloc réduit à ${fitted.reps * fitted.kmEach} km.` : "bloc supprimé.")
        );
        w.longRunMpBlock = fitted;
      }
    }
    for (const w of weeks) {
      const b = w.longRunMpBlock;
      if (b) {
        w.notes.push(
          b.finish
            ? `Sortie longue terminée par ${b.kmEach} km à allure marathon.`
            : `Sortie longue avec ${b.reps} × ${b.kmEach} km à allure marathon (${b.reps * b.kmEach} km au total).`
        );
      } else if (w.phase === "specific" && !w.isDeload && w.longRunMin > 0) {
        w.notes.push("Sortie longue facile : pas de bloc allure marathon.");
      }
    }
    const achieved = Math.max(0, ...weeks.filter((w) => w.phase === "specific").map((w) => (w.longRunMpBlock ? w.longRunMpBlock.reps * w.longRunMpBlock.kmEach : 0)));
    if (achieved < CFG.mpBlock.targetPeakKm) {
      warnings.push(
        `Le bloc maximal à allure marathon est de ${achieved} km (cible ${CFG.mpBlock.targetPeakKm} km) : ` +
          "les courses intermédiaires, leurs jours faciles ou la durée des sorties longues limitent les semaines voulues."
      );
    }
  }

  // ── Notes common to all weeks ──
  for (const w of weeks) {
    const n = w.weeksToRace;
    if (w.isDeload) w.notes.push("Semaine de décharge : 75 % du volume et de la sortie longue.");
    if (peakWeeks.includes(n) && w.longRunMin > 0) w.notes.push(`Pic de sortie longue (S-${n}).`);
  }
  if (peakLong < peakLongMin) {
    warnings.push(`Sortie longue maximale limitée à ${peakLong} min : +${CFG.longRunStepMin} min par semaine de charge depuis ${anchor} min.`);
  }

  return { weeks, warnings, baselineKm: Math.round(baseline * 10) / 10, longRunAnchorMin: anchor, peakKm };
}

/** The plan's week containing `date`, or null. */
export function planWeekFor(plan: RacePlan, date: Date): RacePlanWeek | null {
  const monday = toMonday(date).getTime();
  return plan.weeks.find((w) => w.weekStart.getTime() === monday) ?? null;
}
