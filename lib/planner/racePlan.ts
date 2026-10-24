// Backward race planner: given a goal race (and the tune-up races before it),
// lays out every week from the current one to race week. Pure — history in,
// weeks out; the DB loading lives in lib/planner/generateWeek.ts.
//
// Weeks run Monday-Sunday. Offset n counts weeks back from race week:
//   n = 0 race week, n = 1 the week before, ...
// Phases are assigned backward from the race (taper, specific, development,
// base = the rest), so a short lead time compresses base first.
//
// targetKm is the week's TRAINING volume: races (tune-ups and the goal) are
// not counted in it.

import { addDays, toMonday } from "./dates";

export type RacePhase = "recovery" | "base" | "development" | "specific" | "taper" | "race";

/**
 * The week's key session — what replaces or defines the quality slot:
 * threshold / vo2max: the usual sessions; mp_tempo / race_pace: a continuous
 * tempo at marathon / half-marathon pace; mp_reminder: easy run with short
 * race-pace reminders and strides (the taper's only "quality"); race: a race
 * this week; time_trial / long_tempo: a solo test standing in for a race;
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
  | "long_tempo";

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
}

/** Marathon-pace block inside a long run: `reps` × `kmEach` km. */
export interface MpBlock {
  reps: number;
  kmEach: number;
}

export interface RacePlanWeek {
  weekStart: Date;
  phase: RacePhase;
  /** Training km (the races themselves excluded). */
  targetKm: number;
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
}

export interface RacePlan {
  weeks: RacePlanWeek[];
  warnings: string[];
  baselineKm: number;
  longRunAnchorMin: number;
  peakKm: number;
}

// ─── Tunables ──────────────────────────────────────────────────────────────

type DistanceClass = "marathon" | "half" | "short";

const PHASE_LENGTHS: Record<DistanceClass, { taper: number; specific: number; development: number }> = {
  marathon: { taper: 2, specific: 5, development: 6 },
  half: { taper: 1, specific: 4, development: 4 },
  short: { taper: 1, specific: 3, development: 3 },
};

/** Weeks of lead time below which the plan warns (and compresses base first). */
const MIN_LEAD_WEEKS: Record<DistanceClass, number> = { marathon: 12, half: 8, short: 6 };

/** Weekly training-km ceiling per goal distance — a heuristic; never below the athlete's own baseline. */
const VOLUME_CEILING_KM: Record<DistanceClass, number> = { marathon: 65, half: 50, short: 42 };
const MAX_WEEKLY_INCREASE = 0.1;
const DELOAD_FACTOR = 0.75;
const MIN_LOAD_WEEKS_BEFORE_DELOAD = 2;

const LONG_RUN_STEP_MIN = 10;
const LONG_RUN_CAP_MIN = 180;
const LONG_RUN_CAP_KM = 32;
/** Peak long run per goal distance, under the global cap. */
const LONG_RUN_PEAK_MIN: Record<DistanceClass, number> = { marathon: 180, half: 135, short: 105 };
/** Long-run peaks fall this many weeks before race week. */
const LONG_RUN_PEAK_WEEKS = [5, 3];
const LONG_RUN_SHARE_NOTE_THRESHOLD = 0.4;
/** A short tune-up week keeps its long run at this share of the planned one. */
const TUNE_UP_LONG_RUN_SHARE = 0.6;

/** Taper: share of the peak week's km. Keys are weeks before race week. */
const TAPER_VOLUME: Record<DistanceClass, Record<number, number>> = {
  marathon: { 2: 0.7, 1: 0.55 },
  half: { 1: 0.7 },
  short: { 1: 0.7 },
};
const RACE_WEEK_VOLUME: Record<DistanceClass, number> = { marathon: 0.4, half: 0.45, short: 0.45 };
const TAPER_LONG_RUN_SHARE: Record<number, number> = { 2: 0.65, 1: 0.5 };

/** The post-recovery rule: ceil(race km / 3) easy days after any race before quality. */
const EASY_DAYS_PER_KM = 1 / 3;

const RECOVERY_VOLUME_SHARE = [0.5, 0.7];
const MP_BLOCK_START_KM = 6;
const MP_BLOCK_END_KM = 16;
const MP_BLOCK_MAX_STEP_KM = 4;
const MP_BLOCK_SNAP: Array<{ km: number; block: MpBlock }> = [
  { km: 6, block: { reps: 2, kmEach: 3 } },
  { km: 8, block: { reps: 2, kmEach: 4 } },
  { km: 10, block: { reps: 2, kmEach: 5 } },
  { km: 12, block: { reps: 2, kmEach: 6 } },
  { km: 14, block: { reps: 2, kmEach: 7 } },
  { km: 16, block: { reps: 2, kmEach: 8 } },
];

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
  return addDays(raceDate, Math.ceil(distanceKm * EASY_DAYS_PER_KM) + 1);
}

function snapMpBlock(km: number): MpBlock {
  const nearest = MP_BLOCK_SNAP.reduce((best, s) => (Math.abs(s.km - km) < Math.abs(best.km - km) ? s : best));
  return nearest.block;
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

/** Longest run (min) of the 12 weeks before today, floored to 5 min, at least 30 — the long-run anchor. */
function longRunAnchorMin(history: RacePlanHistory): number {
  const cutoff = addDays(history.today, -84);
  const longest = history.activities
    .filter((a) => a.startTime >= cutoff && isRunning(a.activityType))
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
  if (leadWeeks < MIN_LEAD_WEEKS[klass]) {
    warnings.push(
      `Préparation courte : ${leadWeeks} semaines avant la course, ${MIN_LEAD_WEEKS[klass]} recommandées. ` +
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
  const lengths = PHASE_LENGTHS[klass];
  const goalSet = [goalRace, ...tuneUps];
  const weeks: RacePlanWeek[] = Array.from({ length: weekCount }, (_, i) => {
    const n = weekCount - 1 - i;
    const weekStart = addDays(planStart, 7 * i);
    let phase: RacePhase;
    if (n === 0) phase = "race";
    else if (n <= lengths.taper) phase = "taper";
    else if (n <= lengths.taper + lengths.specific) phase = "specific";
    else if (n <= lengths.taper + lengths.specific + lengths.development) phase = "development";
    else phase = "base";
    if (i < recoveryWeeks && n > 0) phase = "recovery";
    // Every 4th week back from the race — but never before two load weeks have been built after recovery.
    const isDeload = n > 0 && n % 4 === 0 && phase !== "recovery" && i - recoveryWeeks >= MIN_LOAD_WEEKS_BEFORE_DELOAD;
    return {
      weekStart,
      phase,
      targetKm: 0,
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
    };
  });

  const isLoad = (w: RacePlanWeek) => !["recovery", "taper", "race"].includes(w.phase) && !w.isDeload;

  // ── Volume: ramp from the baseline to the ceiling, ≤ +10 %/week, deload at 75 % ──
  const ceiling = Math.max(VOLUME_CEILING_KM[klass], baseline);
  const loadWeeks = weeks.filter(isLoad);
  let lastLoadKm = baseline;
  let loadIndex = 0;
  for (const w of weeks) {
    if (w.phase === "recovery") {
      const idx = weeks.filter((x) => x.phase === "recovery").indexOf(w);
      w.targetKm = Math.round(baseline * RECOVERY_VOLUME_SHARE[Math.min(idx, RECOVERY_VOLUME_SHARE.length - 1)]);
    } else if (w.isDeload) {
      w.targetKm = Math.round(lastLoadKm * DELOAD_FACTOR);
    } else if (isLoad(w)) {
      const t = loadWeeks.length > 1 ? loadIndex / (loadWeeks.length - 1) : 1;
      const desired = baseline + (ceiling - baseline) * t;
      const capped = loadIndex === 0 ? baseline : Math.min(desired, lastLoadKm * (1 + MAX_WEEKLY_INCREASE));
      lastLoadKm = Math.min(ceiling, capped);
      w.targetKm = Math.round(lastLoadKm);
      w.qualityLevel = Math.min(6, Math.floor(loadIndex / 2));
      loadIndex++;
    }
  }
  const peakKm = Math.max(0, ...weeks.filter(isLoad).map((w) => w.targetKm));

  for (const w of weeks) {
    const n = w.weeksToRace;
    if (w.phase === "race") w.targetKm = Math.round(peakKm * RACE_WEEK_VOLUME[klass]);
    else if (w.phase === "taper") w.targetKm = Math.round(peakKm * (TAPER_VOLUME[klass][n] ?? 0.7));
  }

  // ── Long run: anchor → peak (at 5 and 3 weeks out), +10 min per load week at most ──
  const peakLongMin = Math.min(
    LONG_RUN_CAP_MIN,
    LONG_RUN_PEAK_MIN[klass],
    Math.floor(((LONG_RUN_CAP_KM * easyPace) / 60) / 5) * 5
  );
  const rampWeeks = weeks.filter((w) => isLoad(w) && w.weeksToRace >= LONG_RUN_PEAK_WEEKS[0]);
  const reachable = anchor + LONG_RUN_STEP_MIN * Math.max(0, rampWeeks.length - 1);
  const peakLong = Math.max(anchor, Math.min(peakLongMin, reachable));
  let lastLoadLong = anchor;
  let rampIndex = 0;
  for (const w of weeks) {
    const n = w.weeksToRace;
    if (w.phase === "recovery") {
      const first = weeks.findIndex((x) => x.phase === "recovery") === weeks.indexOf(w);
      w.longRunMin = first ? 0 : Math.min(60, round5(anchor * 0.5));
    } else if (w.phase === "taper") {
      w.longRunMin = round5(peakLong * (TAPER_LONG_RUN_SHARE[n] ?? 0.5));
    } else if (w.phase === "race") {
      w.longRunMin = 0;
    } else if (w.isDeload) {
      w.longRunMin = round5(lastLoadLong * DELOAD_FACTOR);
    } else if (LONG_RUN_PEAK_WEEKS.includes(n)) {
      w.longRunMin = lastLoadLong = peakLong;
    } else if (n > LONG_RUN_PEAK_WEEKS[0]) {
      const t = rampWeeks.length > 1 ? rampIndex / (rampWeeks.length - 1) : 1;
      w.longRunMin = lastLoadLong = round5(anchor + (peakLong - anchor) * t);
      rampIndex++;
    } else {
      w.longRunMin = lastLoadLong; // between the peaks, if the layout leaves a load week there
    }
  }

  // ── Races: they replace the quality (and the long run from the half up) ──
  // After any race, ceil(km / 3) easy days come before quality: a week that starts inside that window
  // may only hold quality from qualityFromDay on.
  const finishedRaces: Array<{ raceDate: Date; distanceKm: number }> = [...goalSet];
  if (last) finishedRaces.push(last);
  for (const w of weeks) {
    const from = Math.max(
      0,
      ...finishedRaces
        .filter((r) => r.raceDate < w.weekStart)
        .map((r) => daysBetween(w.weekStart, qualityAllowedFrom(r.raceDate, r.distanceKm)))
    );
    w.qualityFromDay = Math.min(7, from);
  }

  // A race week runs the race-week template (rules.ts): two short easy runs around the race, the long
  // run only for a race under a half — so its training km is far below the ramp's number.
  const raceWeekEasyKm = Math.round((RACE_WEEK_EASY_MINUTES * 60) / easyPace);

  const raceById = new Map(goalSet.map((r) => [r.id, r]));
  for (const w of weeks) {
    for (const id of w.raceIds) {
      const r = raceById.get(id)!;
      const isGoal = r.id === goalRace.id;
      if (isGoal) {
        w.keySession = "race";
        w.notes.push(`Semaine de course : ${r.name} (${r.distanceKm} km), le ${r.raceDate.toISOString().slice(0, 10)}.`);
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
        w.longRunMin = round5(w.longRunMin * TUNE_UP_LONG_RUN_SHARE);
        w.notes.push(
          `Sortie longue allégée (${Math.round(TUNE_UP_LONG_RUN_SHARE * 100)} %), au plus tard ${LONG_RUN_DAYS_BEFORE_RACE} jours avant la course, jamais après.`
        );
      }
    }
  }

  for (const w of weeks) {
    if (w.raceIds.length === 0) continue;
    const longKm = Math.round((w.longRunMin * 60) / easyPace);
    w.targetKm = Math.min(w.targetKm, raceWeekEasyKm + longKm);
    if (w.phase !== "race") w.notes.push("Volume réduit : footings courts autour de la course, la course elle-même n'est pas comptée.");
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
    if (w.phase === "taper") {
      if (n === 1) {
        w.keySession = "mp_reminder";
        w.notes.push(
          klass === "marathon"
            ? "Affûtage : footing avec quelques rappels courts à allure marathon + lignes droites. Rien de dur."
            : "Affûtage : footing avec quelques rappels courts à allure course + lignes droites. Rien de dur."
        );
      } else {
        w.keySession = "threshold";
        w.notes.push(`Affûtage (S-${n}) : séance de seuil courte, ≈ ${Math.round((TAPER_VOLUME[klass][n] ?? 0.7) * 100)} % du pic de volume.`);
      }
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

  // ── Marathon-pace blocks in the long run (marathon, specific phase) ──
  if (klass === "marathon") {
    const eligible = weeks.filter(
      (w) => w.phase === "specific" && !w.isDeload && w.longRunMin > 0 && w.raceIds.length === 0
    );
    // The long run lands on Saturday (day 5): the post-race easy days must be over by then.
    const usable = eligible.filter((w) => w.qualityFromDay <= LONG_RUN_DAY);
    let km = MP_BLOCK_START_KM;
    usable.forEach((w, i) => {
      const target = usable.length > 1 ? MP_BLOCK_START_KM + ((MP_BLOCK_END_KM - MP_BLOCK_START_KM) * i) / (usable.length - 1) : MP_BLOCK_START_KM;
      km = Math.min(target, km + (i === 0 ? 0 : MP_BLOCK_MAX_STEP_KM));
      w.longRunMpBlock = snapMpBlock(km);
      const total = w.longRunMpBlock.reps * w.longRunMpBlock.kmEach;
      w.notes.push(`Sortie longue avec ${w.longRunMpBlock.reps} × ${w.longRunMpBlock.kmEach} km à allure marathon (${total} km au total).`);
    });
    const peakMp = Math.max(0, ...usable.map((w) => (w.longRunMpBlock ? w.longRunMpBlock.reps * w.longRunMpBlock.kmEach : 0)));
    if (peakMp < MP_BLOCK_END_KM - 2) {
      warnings.push(
        `Le calendrier ne laisse que ${usable.length} sortie(s) longue(s) avec allure marathon : le bloc maximal est de ${peakMp} km ` +
          `(cible 14–16 km). Les courses intermédiaires et leurs jours faciles occupent les autres semaines.`
      );
    }
    for (const w of weeks) {
      if (w.phase === "specific" && !w.isDeload && !w.longRunMpBlock && w.longRunMin > 0) {
        w.notes.push("Sortie longue facile : pas de bloc allure marathon (jours faciles après une course).");
      }
    }
  }

  // ── Notes common to all weeks ──
  for (const w of weeks) {
    const n = w.weeksToRace;
    if (w.isDeload) w.notes.push("Semaine de décharge : 75 % du volume et de la sortie longue.");
    if (LONG_RUN_PEAK_WEEKS.includes(n) && w.longRunMin > 0) w.notes.push(`Pic de sortie longue (S-${n}).`);
    const longKm = (w.longRunMin * 60) / easyPace;
    if (w.targetKm > 0 && longKm / w.targetKm > LONG_RUN_SHARE_NOTE_THRESHOLD) {
      w.notes.push(
        `La sortie longue pèse ${Math.round((longKm / w.targetKm) * 100)} % du volume : une 5e sortie facile répartirait mieux la charge.`
      );
    }
  }
  if (peakLong < Math.min(peakLongMin, LONG_RUN_CAP_MIN)) {
    warnings.push(`Sortie longue maximale limitée à ${peakLong} min : +${LONG_RUN_STEP_MIN} min par semaine de charge depuis ${anchor} min.`);
  }

  return { weeks, warnings, baselineKm: Math.round(baseline * 10) / 10, longRunAnchorMin: anchor, peakKm };
}

/** The plan's week containing `date`, or null. */
export function planWeekFor(plan: RacePlan, date: Date): RacePlanWeek | null {
  const monday = toMonday(date).getTime();
  return plan.weeks.find((w) => w.weekStart.getTime() === monday) ?? null;
}
