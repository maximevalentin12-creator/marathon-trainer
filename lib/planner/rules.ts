/**
 * Rule-based planner. Public API: buildWeekPlan(input) → WeekPlan. The methodology
 * it encodes (2–3 sessions/week, polarised intensity, HR-zone targets) is described in the README.
 */

import type {
  AthleteCalibration,
  KeptSession,
  Modality,
  NonImpactMachine,
  PlannedSession,
  PlannerInput,
  RaceModeInput,
  SessionKind,
  SessionStep,
  SessionVariant,
  SubjectiveSignal,
  WeekPlan,
} from "./types";
import { hrHint, type HeartRateZones } from "./zones";
import { addDays } from "./dates";
import { decideDowngrade, findApplicableSignal, shouldAddStrides } from "./subjective";
import {
  buildNonImpactEasySession,
  buildNonImpactThresholdSession,
  buildNonImpactVo2maxSession,
} from "./nonImpact";

// ─── Small numeric helpers ──────────────────────────────────────────────────

function round5(n: number): number {
  return Math.round(n / 5) * 5;
}

function fmtPace(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

/** km covered running `minutes` at `paceSecPerKm` — raw, not rounded (callers sum several before rounding). */
function stepKm(minutes: number, paceSecPerKm: number): number {
  return (minutes * 60) / paceSecPerKm;
}

// ─── "Why" notes (spec §5 — exact plain-language wording) ──────────────────

const WHY_EASY =
  "Construire ta base aérobie sans ajouter de fatigue significative — celle-ci ne doit jamais être difficile.";
const WHY_LONG =
  "Apprendre au corps à tenir plus longtemps, sans lien avec la vitesse — c'est la durée qui compte ici, pas l'allure.";
const WHY_LONG_PROGRESSION =
  "Apprendre au corps à tenir plus longtemps ; cette semaine, les dernières minutes montent légèrement en intensité pour un petit stimulus supplémentaire, sans forcer.";
const WHY_THRESHOLD =
  "Augmenter la vitesse que tu peux tenir sur la durée — la seule séance de la semaine où tu dois vraiment forcer, mais toujours de façon contrôlée, jamais à fond.";
const WHY_VO2MAX =
  "Habituer le cœur et les poumons à un effort très intense, par courtes doses — la séance la plus coûteuse de la semaine, donc volontairement courte.";
const WHY_THRESHOLD_RACE =
  "Garder du rythme avant la course sans accumuler de fatigue — séance courte et contrôlée, jamais à fond.";

/** The race's own note. The 15th-km cue only fits a long race; shorter ones hold until the last 3 km. */
function whyRace(distanceKm: number): string {
  const hold = distanceKm > 15 ? "jusqu'au 15e km" : "jusqu'aux 3 derniers km";
  return `Pas d'objectif de temps : pars dans ta zone facile et tiens-la ${hold}, accélère seulement si tout va bien. Bois à chaque ravitaillement.`;
}

// ─── Treadmill helpers (spec §4bis — min 1% incline rule) ───────────────────

const INCLINE_PATTERN = [1, 3, 1, 4];

/** Alternating-incline segments for a continuous indoor session, breaking monotony without changing target effort. */
function inclineSteps(totalMinutes: number, zoneLabel: string, heartRateHint: string, segmentLen = 6): SessionStep[] {
  const steps: SessionStep[] = [];
  let remaining = totalMinutes;
  let i = 0;
  while (remaining > 0) {
    const len = Math.min(segmentLen, remaining);
    const incline = INCLINE_PATTERN[i % INCLINE_PATTERN.length];
    steps.push({
      label: `Tapis — inclinaison ${incline} %`,
      durationMinutes: len,
      description: "Ajuste légèrement l'allure pour garder la même sensation d'effort",
      zoneLabel,
      heartRateHint,
    });
    remaining -= len;
    i++;
  }
  return steps;
}

function warmupStep(minutes: number, indoor: boolean, zones: HeartRateZones): SessionStep {
  return {
    label: "Échauffement",
    durationMinutes: minutes,
    description: indoor ? "Tapis à 1 % d'inclinaison minimum" : "Facile, continu",
    zoneLabel: "Facile",
    heartRateHint: hrHint(zones, "facile"),
  };
}

function cooldownStep(minutes: number, indoor: boolean, zones: HeartRateZones): SessionStep {
  return {
    label: "Retour au calme",
    durationMinutes: minutes,
    description: indoor ? "Tapis à 1 % d'inclinaison minimum" : "Facile, continu",
    zoneLabel: "Facile",
    heartRateHint: hrHint(zones, "facile"),
  };
}

function stridesStep(reps = 6): SessionStep {
  return {
    label: "Lignes droites (strides)",
    durationMinutes: null,
    description: `${reps} × 20 s à allure rapide mais relâchée, récupération marche/trot entre chaque`,
    zoneLabel: "Vive — non pilotée à la FC",
  };
}

// ─── Quality-session progression tables (spec §3 priority 2, §4 ranges) ─────
// Palier 0 starts below the eventual §4 target range and grows into it as
// qualityLevel advances — see spec §1's "Palier 0" framing.

// VO2max intervals are prescribed by perceived effort, not pace (spec §4) — there is no
// real target pace to fall back on. This offset is only used to estimate distance for the
// mileage card, roughly placing VO2max effort near 5K-race pace, faster than the 10 km
// reference pace threshold sessions are built from. Deliberately approximate.
const VO2MAX_PACE_ADJUSTMENT_SEC_PER_KM = -20;

const THRESHOLD_LEVELS: ReadonlyArray<{ reps: number; workMin: number }> = [
  { reps: 3, workMin: 6 },
  { reps: 3, workMin: 8 },
  { reps: 3, workMin: 10 },
  { reps: 3, workMin: 12 },
  { reps: 4, workMin: 12 },
  { reps: 4, workMin: 14 },
  { reps: 4, workMin: 15 },
];

const VO2MAX_LEVELS: ReadonlyArray<{ reps: number; workMin: number }> = [
  { reps: 5, workMin: 3 },
  { reps: 5, workMin: 3 },
  { reps: 5, workMin: 4 },
  { reps: 6, workMin: 3 },
  { reps: 6, workMin: 4 },
  { reps: 6, workMin: 4 },
  { reps: 6, workMin: 4 },
];

function levelAt<T>(levels: ReadonlyArray<T>, level: number): T {
  return levels[Math.max(0, Math.min(level, levels.length - 1))];
}

const THRESHOLD_WARMUP_MINUTES = 8;
const THRESHOLD_COOLDOWN_MINUTES = 8;

interface IntervalStructure {
  reps: number;
  workMin: number;
  recoveryMin: number;
}

function thresholdStructure(level: number): IntervalStructure {
  const { reps, workMin } = levelAt(THRESHOLD_LEVELS, level);
  return { reps, workMin, recoveryMin: workMin <= 8 ? 2 : 3 };
}

/** Total minutes of a classic threshold session with this structure, warm-up and cool-down included. */
function thresholdTotalMinutes({ reps, workMin, recoveryMin }: IntervalStructure): number {
  return THRESHOLD_WARMUP_MINUTES + reps * workMin + (reps - 1) * recoveryMin + THRESHOLD_COOLDOWN_MINUTES;
}

// ─── Session-body builders ───────────────────────────────────────────────

function buildEasySteps(minutes: number, indoor: boolean, zones: HeartRateZones): SessionStep[] {
  if (!indoor) {
    return [
      {
        label: "Continu",
        durationMinutes: minutes,
        description: "Conversation aisée du début à la fin",
        zoneLabel: "Facile",
        heartRateHint: hrHint(zones, "facile"),
      },
    ];
  }
  return inclineSteps(minutes, "Facile", hrHint(zones, "facile"));
}

function buildLongSteps(
  minutes: number,
  variant: SessionVariant,
  indoor: boolean,
  zones: HeartRateZones
): SessionStep[] {
  if (variant !== "progression") {
    return indoor
      ? inclineSteps(minutes, "Facile", hrHint(zones, "facile"))
      : [
          {
            label: "Continu",
            durationMinutes: minutes,
            description: "Conversation aisée du début à la fin",
            zoneLabel: "Facile",
            heartRateHint: hrHint(zones, "facile"),
          },
        ];
  }

  const finalMin = Math.max(5, round5(minutes * 0.12));
  const baseMin = minutes - finalMin;
  const baseSteps = indoor
    ? inclineSteps(baseMin, "Facile", hrHint(zones, "facile"))
    : [
        {
          label: "Continu",
          durationMinutes: baseMin,
          description: "Conversation aisée",
          zoneLabel: "Facile",
          heartRateHint: hrHint(zones, "facile"),
        },
      ];
  const finalStep: SessionStep = {
    label: indoor ? "Fin — inclinaison 4 %" : "Fin de séance",
    durationMinutes: finalMin,
    description: "Dernière portion en zone Aérobie — un peu plus soutenu, sans forcer",
    zoneLabel: "Aérobie",
    heartRateHint: hrHint(zones, "aerobie"),
  };
  return [...baseSteps, finalStep];
}

function buildThresholdBody(
  structure: IntervalStructure,
  variant: SessionVariant,
  indoor: boolean,
  cal: AthleteCalibration
): { steps: SessionStep[]; totalMinutes: number; distanceKm: number } {
  const paceRef = cal.paceReferenceSecPerKm;
  const { reps, workMin, recoveryMin } = structure;
  const paceHint = `≈${fmtPace(paceRef + 3)}–${fmtPace(paceRef + 13)}/km`;
  const warm = THRESHOLD_WARMUP_MINUTES;
  const cool = THRESHOLD_COOLDOWN_MINUTES;
  const easyPace = cal.easyPaceSecPerKm;
  // Midpoint of the displayed range above — same value already used as targetPaceSecondsPerKm.
  const thresholdPace = paceRef + 8;

  let corps: SessionStep;
  let corpsMin: number;
  let corpsKm: number;

  if (variant === "fartlek") {
    corpsMin = reps * workMin;
    // No explicit work/recovery split to estimate from — the whole block is effort-dominant
    // free running, so it's costed at threshold pace throughout (a slight overestimate).
    corpsKm = stepKm(corpsMin, thresholdPace);
    corps = {
      label: "Corps de séance",
      durationMinutes: corpsMin,
      description: `≈${corpsMin} min d'efforts libres en zone Seuil, alternés au ressenti avec du zone Facile`,
      zoneLabel: "Seuil (effort libre)",
      heartRateHint: `${hrHint(cal.zones, "seuil")} en effort`,
      paceHint,
    };
  } else {
    corpsMin = reps * workMin + (reps - 1) * recoveryMin;
    corpsKm = stepKm(reps * workMin, thresholdPace) + stepKm((reps - 1) * recoveryMin, easyPace);
    corps = {
      label: "Corps de séance",
      durationMinutes: corpsMin,
      description: `${reps} × ${workMin} min zone Seuil, récup ${recoveryMin} min zone Facile entre blocs`,
      zoneLabel: "Seuil",
      heartRateHint: hrHint(cal.zones, "seuil"),
      paceHint,
    };
  }

  const distanceKm = stepKm(warm, easyPace) + corpsKm + stepKm(cool, easyPace);

  return {
    steps: [warmupStep(warm, indoor, cal.zones), corps, cooldownStep(cool, indoor, cal.zones)],
    totalMinutes: warm + corpsMin + cool,
    distanceKm,
  };
}

function buildVo2maxBody(
  level: number,
  variant: SessionVariant,
  indoor: boolean,
  cal: AthleteCalibration
): { steps: SessionStep[]; totalMinutes: number; distanceKm: number | null } {
  const { reps, workMin } = levelAt(VO2MAX_LEVELS, level);
  const recoveryMin = workMin;
  const warm = 8;
  const cool = variant === "hills" ? 7 : 8;
  const corpsMin = reps * workMin + (reps - 1) * recoveryMin;

  const corps: SessionStep =
    variant === "hills"
      ? {
          label: "Corps de séance",
          durationMinutes: corpsMin,
          description: `${reps} × ${workMin} min en côte, effort « très dur », récup en ${
            indoor ? "marche, tapis à 1 % d'inclinaison" : "descente/marche"
          }`,
          zoneLabel: indoor ? "Tapis — inclinaison 6–8 %" : "En côte",
          heartRateHint: "FC en fin de rép seulement : haut Seuil / début Maximum",
        }
      : {
          label: "Corps de séance",
          durationMinutes: corpsMin,
          description: `${reps} × ${workMin} min effort « très dur », récup ${recoveryMin} min zone Facile`,
          zoneLabel: "Maximum (sensation)",
          heartRateHint: "FC en fin de rép seulement : haut Seuil / début Maximum",
        };

  // Hills (treadmill incline or real hill) cover less ground for the same effort than flat
  // running — without a real gradient model that would be speculative, so no distance estimate.
  const distanceKm =
    variant === "hills"
      ? null
      : stepKm(warm, cal.easyPaceSecPerKm) +
        stepKm(reps * workMin, cal.paceReferenceSecPerKm + VO2MAX_PACE_ADJUSTMENT_SEC_PER_KM) +
        stepKm((reps - 1) * recoveryMin, cal.easyPaceSecPerKm) +
        stepKm(cool, cal.easyPaceSecPerKm);

  return {
    steps: [warmupStep(warm, indoor, cal.zones), corps, cooldownStep(cool, indoor, cal.zones)],
    totalMinutes: warm + corpsMin + cool,
    distanceKm,
  };
}

// ─── Full-session builders ──────────────────────────────────────────────

function buildRestSession(
  userId: string,
  plannedDate: Date,
  downgradedFrom: SessionKind,
  reason: string
): PlannedSession {
  return {
    userId,
    plannedDate,
    kind: "rest",
    label: "Repos (adapté)",
    variant: "plain",
    modality: "running",
    indoor: false,
    inclinePercent: null,
    machine: null,
    targetDurationMinutes: 0,
    targetDistanceKm: null,
    targetPaceSecondsPerKm: null,
    zoneSummary: "—",
    steps: [],
    whyNote: reason,
    zoneReference: [],
    stridesAdded: false,
    downgradedFrom,
    downgradeReason: reason,
  };
}

function buildEasySession(
  userId: string,
  plannedDate: Date,
  minutes: number,
  indoor: boolean,
  cal: AthleteCalibration,
  addStrides: boolean,
  downgradedFrom: SessionKind | null,
  downgradeReason: string | null,
  /** Strides that are part of the prescription (race week), not an energy bonus — stridesAdded stays false. */
  prescribedStrideReps: number | null = null
): PlannedSession {
  const pace = cal.easyPaceSecPerKm;
  const steps = buildEasySteps(minutes, indoor, cal.zones);
  if (addStrides) steps.push(stridesStep());
  else if (prescribedStrideReps) steps.push(stridesStep(prescribedStrideReps));
  const totalMinutes = addStrides || prescribedStrideReps ? minutes + 5 : minutes;

  return {
    userId,
    plannedDate,
    kind: "easy",
    label: downgradedFrom ? "Facile (adaptée)" : "Facile",
    variant: "plain",
    modality: "running",
    indoor,
    inclinePercent: indoor ? 1 : null,
    machine: null,
    targetDurationMinutes: totalMinutes,
    targetDistanceKm: Math.round(((minutes * 60) / pace) * 10) / 10,
    targetPaceSecondsPerKm: pace,
    zoneSummary: "Facile",
    steps,
    whyNote: downgradeReason ? `${WHY_EASY} (${downgradeReason})` : WHY_EASY,
    zoneReference: [cal.zones.facile],
    stridesAdded: addStrides,
    downgradedFrom,
    downgradeReason,
  };
}

function buildLongSession(
  userId: string,
  plannedDate: Date,
  minutes: number,
  variant: SessionVariant,
  indoor: boolean,
  cal: AthleteCalibration,
  downgradedFrom: SessionKind | null,
  downgradeReason: string | null
): PlannedSession {
  const steps = buildLongSteps(minutes, variant, indoor, cal.zones);
  const pace = cal.easyPaceSecPerKm;
  const label = downgradedFrom
    ? "Longue facile (adaptée)"
    : variant === "progression"
      ? "Longue facile, avec progression finale"
      : "Longue facile";
  const why = variant === "progression" ? WHY_LONG_PROGRESSION : WHY_LONG;

  return {
    userId,
    plannedDate,
    kind: "long",
    label,
    variant,
    modality: "running",
    indoor,
    inclinePercent: indoor ? 1 : null,
    machine: null,
    targetDurationMinutes: minutes,
    targetDistanceKm: Math.round(((minutes * 60) / pace) * 10) / 10,
    targetPaceSecondsPerKm: pace,
    zoneSummary: variant === "progression" ? "Facile → Aérobie" : "Facile",
    steps,
    whyNote: downgradeReason ? `${why} (${downgradeReason})` : why,
    zoneReference:
      variant === "progression"
        ? [cal.zones.facile, cal.zones.aerobie]
        : [cal.zones.facile],
    stridesAdded: false,
    downgradedFrom,
    downgradeReason,
  };
}

function buildThresholdSession(
  userId: string,
  plannedDate: Date,
  level: number,
  variant: SessionVariant,
  indoor: boolean,
  cal: AthleteCalibration,
  /** Race mode's reduction week: the short fixed session instead of the progression level. */
  raceShort = false
): PlannedSession {
  const structure = raceShort ? REDUCTION_THRESHOLD : thresholdStructure(level);
  const { steps, totalMinutes, distanceKm } = buildThresholdBody(structure, variant, indoor, cal);
  const label = raceShort
    ? "Qualité : Seuil court"
    : variant === "fartlek"
      ? "Qualité : Fartlek soutenu"
      : "Qualité : Seuil classique";

  return {
    userId,
    plannedDate,
    kind: "threshold",
    label,
    variant,
    modality: "running",
    indoor,
    inclinePercent: indoor ? 1 : null,
    machine: null,
    targetDurationMinutes: totalMinutes,
    targetDistanceKm: Math.round(distanceKm * 10) / 10,
    targetPaceSecondsPerKm: cal.paceReferenceSecPerKm + 8,
    zoneSummary: "Facile → Seuil → Facile",
    steps,
    whyNote: raceShort ? WHY_THRESHOLD_RACE : WHY_THRESHOLD,
    zoneReference: [cal.zones.facile, cal.zones.seuil],
    stridesAdded: false,
    downgradedFrom: null,
    downgradeReason: null,
  };
}

function buildVo2maxSession(
  userId: string,
  plannedDate: Date,
  level: number,
  variant: SessionVariant,
  indoor: boolean,
  cal: AthleteCalibration
): PlannedSession {
  const { steps, totalMinutes, distanceKm } = buildVo2maxBody(level, variant, indoor, cal);
  const label = variant === "hills" ? "Qualité : Côtes" : "Qualité : VO2max classique";

  return {
    userId,
    plannedDate,
    kind: "vo2max",
    label,
    variant,
    modality: "running",
    indoor,
    inclinePercent: indoor ? (variant === "hills" ? 7 : 1) : null,
    machine: null,
    targetDurationMinutes: totalMinutes,
    targetDistanceKm: distanceKm !== null ? Math.round(distanceKm * 10) / 10 : null,
    targetPaceSecondsPerKm: null,
    zoneSummary: "Facile → Maximum (sensation) → Facile",
    steps,
    whyNote: WHY_VO2MAX,
    zoneReference: [cal.zones.facile, cal.zones.seuil, cal.zones.maximum],
    stridesAdded: false,
    downgradedFrom: null,
    downgradeReason: null,
  };
}

/** The race itself: no time target and no pace — the distance is the target. */
function buildRaceSession(
  userId: string,
  plannedDate: Date,
  race: RaceModeInput,
  cal: AthleteCalibration
): PlannedSession {
  const km = String(race.distanceKm).replace(".", ",");
  return {
    userId,
    plannedDate,
    kind: "race",
    label: `Course : ${race.raceName}`,
    variant: "plain",
    modality: "running",
    indoor: false,
    inclinePercent: null,
    machine: null,
    targetDurationMinutes: 0,
    targetDistanceKm: race.distanceKm,
    targetPaceSecondsPerKm: null,
    zoneSummary: "Facile",
    steps: [
      {
        label: "Course",
        durationMinutes: null,
        description: `${km} km — départ en zone Facile, accélération seulement en fin de course si tout va bien`,
        zoneLabel: "Facile",
        heartRateHint: hrHint(cal.zones, "facile"),
      },
    ],
    whyNote: whyRace(race.distanceKm),
    zoneReference: [cal.zones.facile],
    stridesAdded: false,
    downgradedFrom: null,
    downgradeReason: null,
  };
}

// ─── Race mode (race.ts positions the week; these are its sessions) ────────

/** Reduction week: share of the normal week's minutes, its long run and its one quality session. */
const REDUCTION_VOLUME_FACTOR = 0.7;
const REDUCTION_LONG_RUN_MINUTES = 60;
const REDUCTION_THRESHOLD: IntervalStructure = { reps: 3, workMin: 5, recoveryMin: 2 };
/** Recovery week (the week after the race): share of the normal week's minutes. */
const RECOVERY_VOLUME_FACTOR = 0.5;
/** Race-mode easy sessions never go below this, even when it overshoots the volume target. */
const RACE_MODE_MIN_EASY_MINUTES = 20;

/** Race week: two short easy runs, then nothing hard and full rest on the days before the race. */
const RACE_WEEK_FIRST_EASY_MINUTES = 30;
const RACE_WEEK_STRIDES_EASY_MINUTES = 20;
const RACE_WEEK_STRIDE_REPS = 4;
const RACE_WEEK_NON_IMPACT_MINUTES = 30;
const RACE_WEEK_REST_DAYS_BEFORE = 2;

/**
 * The normal week's roles, reshaped for race mode — the slots (so the weekly
 * setup) are unchanged. Reduction: no hard non-impact session. Recovery: easy
 * only.
 */
function raceModeArchitecture(slots: ArchSlot[], raceMode: RaceModeInput | null): ArchSlot[] {
  if (raceMode?.position === "reduction") {
    return slots.map((s) => (s.modality === "non_impact" && s.role === "quality" ? { ...s, role: "easy" } : s));
  }
  if (raceMode?.position === "recovery") return slots.map((s) => ({ ...s, role: "easy" }));
  return slots;
}

/**
 * Splits `targetMinutes` across `count` easy sessions in 5-min steps, the
 * leftover steps going to the latest ones, each at least the race-mode floor.
 */
function distributeEasyMinutes(targetMinutes: number, count: number): number[] {
  if (count <= 0) return [];
  const units = Math.max(0, Math.round(targetMinutes / 5));
  const base = Math.floor(units / count);
  const extra = units % count;
  return Array.from({ length: count }, (_, k) =>
    Math.max(RACE_MODE_MIN_EASY_MINUTES, (base + (k >= count - extra ? 1 : 0)) * 5)
  );
}

/**
 * Easy-session minutes per architecture slot for the reduction and recovery
 * weeks: the week's volume target (a share of what the normal planner would
 * prescribe for the same setup) minus its fixed sessions, spread over the
 * easy slots. Computed on the full week, kept sessions or not, so it stays
 * the same across regenerations.
 */
function raceModeEasyMinutesBySlot(
  input: PlannerInput,
  architecture: ArchSlot[],
  raceMode: RaceModeInput
): Map<number, number> {
  const normal = buildWeekPlan({
    ...input,
    raceMode: null,
    keptSessions: [],
    firstPlannableDay: 0,
    slotOverrides: undefined,
    subjectiveEntries: [],
  });
  const normalMinutes = normal.sessions.reduce((sum, s) => sum + s.targetDurationMinutes, 0);
  const factor = raceMode.position === "reduction" ? REDUCTION_VOLUME_FACTOR : RECOVERY_VOLUME_FACTOR;
  const fixedMinutes = architecture.reduce(
    (sum, s) =>
      sum +
      (s.role === "long"
        ? REDUCTION_LONG_RUN_MINUTES
        : s.role === "quality"
          ? thresholdTotalMinutes(REDUCTION_THRESHOLD)
          : 0),
    0
  );
  const easyIndices = architecture.map((s, i) => (s.role === "easy" ? i : -1)).filter((i) => i !== -1);
  const minutes = distributeEasyMinutes(normalMinutes * factor - fixedMinutes, easyIndices.length);
  return new Map(easyIndices.map((slotIndex, k) => [slotIndex, minutes[k]]));
}

/** Race week roles: the 30-min easy run, the easy run with strides, the race. */
type RaceWeekRole = "easy" | "strides" | "race";

interface RaceWeekSlot {
  modality: Modality;
  role: RaceWeekRole;
}

/**
 * The race week's slots for this setup. One running slot is the race; up to
 * two others become the easy runs — with only one, it's the strides run,
 * closest to the race. A fourth run is dropped (nothing more before a race).
 * The race is always there, even with no running slot in the setup.
 */
function raceWeekArchitecture(runsPerWeek: number, nonImpactSessions: number): RaceWeekSlot[] {
  const easyRunCount = Math.min(2, Math.max(0, runsPerWeek - 1));
  const easyRuns = (["easy", "strides"] as const).slice(2 - easyRunCount);
  return [
    ...easyRuns.map((role) => ({ modality: "running" as const, role })),
    ...Array.from({ length: nonImpactSessions }, () => ({ modality: "non_impact" as const, role: "easy" as const })),
    { modality: "running", role: "race" },
  ];
}

/** `n` days from the sorted `pool`, earliest first, leaving a day between picks when the pool allows it. */
function pickSpreadDays(pool: number[], n: number): number[] {
  const chosen: number[] = [];
  while (chosen.length < Math.min(n, pool.length)) {
    const last = chosen[chosen.length - 1];
    const later = pool.filter((d) => last === undefined || d > last);
    const next = later.find((d) => last === undefined || d > last + 1) ?? later[0];
    if (next === undefined) break;
    chosen.push(next);
  }
  return chosen;
}

/**
 * The race week. Before the race: the easy runs on the earliest free days,
 * spaced out when possible and never the day after a long run; the
 * non-impact sessions on what's left, the day after a long run first.
 * Nothing on the two days before the race, nor after it. A slot that finds
 * no day is dropped — the 30-min run before the strides run. Subjective
 * downgrades apply to everything but the race.
 */
function buildRaceWeekPlan(input: PlannerInput, raceMode: RaceModeInput): WeekPlan {
  const { userId, weekStartDate, calibration, subjectiveEntries, nonImpactMachines, slotOverrides } = input;
  const keptSessions = input.keptSessions ?? [];
  const architecture = raceWeekArchitecture(input.runsPerWeek, input.nonImpactSessions);
  const raceIndex = architecture.length - 1;
  const raceOffset = Math.round((raceMode.raceDate.getTime() - weekStartDate.getTime()) / 86_400_000);
  const firstPlannableDay = Math.max(0, Math.min(7, input.firstPlannableDay ?? 0));
  const keptDays = new Set(keptSessions.map((k) => k.dayOffset));

  // Kept sessions use up a slot: the race its own, any other the first open one of its modality.
  const open = new Set(architecture.map((_, i) => i));
  for (const k of keptSessions) {
    const idx =
      k.kind === "race"
        ? raceIndex
        : Array.from(open)
            .sort((a, b) => a - b)
            .find((i) => architecture[i].modality === k.modality && architecture[i].role !== "race");
    if (idx !== undefined) open.delete(idx);
  }
  const openList = Array.from(open).sort((a, b) => a - b);

  const candidates = Array.from(new Set(input.availableDays))
    .filter((d) => d >= firstPlannableDay && d < raceOffset - RACE_WEEK_REST_DAYS_BEFORE && !keptDays.has(d))
    .sort((a, b) => a - b);
  const afterLong = new Set<number>(input.previousWeekLongRunOnSunday ? [0] : []);

  const runSlots = openList.filter((i) => architecture[i].modality === "running" && architecture[i].role !== "race");
  const runDays = pickSpreadDays(
    candidates.filter((d) => !afterLong.has(d)),
    runSlots.length
  );
  const placedRuns = runSlots.slice(runSlots.length - runDays.length);
  const nonImpactSlots = openList.filter((i) => architecture[i].modality === "non_impact");
  const nonImpactDays = candidates
    .filter((d) => !runDays.includes(d))
    .sort((a, b) => Number(afterLong.has(b)) - Number(afterLong.has(a)) || a - b)
    .slice(0, nonImpactSlots.length);
  const placedNonImpact = nonImpactSlots.slice(0, nonImpactDays.length);

  // Manual day overrides can move the sessions before the race, within the same allowed days.
  const beforeRace = [...placedRuns, ...placedNonImpact];
  const overridesByPos: Record<number, number> = {};
  beforeRace.forEach((slotIndex, pos) => {
    const day = slotOverrides?.[slotIndex];
    if (day !== undefined) overridesByPos[pos] = day;
  });
  const days = applyDayOverrides([...runDays, ...nonImpactDays], overridesByPos, candidates);

  const keptIndoorRuns = keptSessions.filter((k) => k.modality === "running" && k.indoor).length;
  let indoorLeft = Math.max(0, Math.min(input.indoorRuns, input.runsPerWeek) - keptIndoorRuns);

  const sessions: PlannedSession[] = [];
  const slotIndices: number[] = [];
  beforeRace.forEach((slotIndex, pos) => {
    const slot = architecture[slotIndex];
    const plannedDate = addDays(weekStartDate, days[pos]);
    const decision = decideDowngrade("easy", findApplicableSignal(subjectiveEntries, plannedDate));
    slotIndices.push(slotIndex);
    if (decision.type === "rest") {
      sessions.push(buildRestSession(userId, plannedDate, "easy", decision.reason));
    } else if (slot.modality === "non_impact") {
      sessions.push(
        buildNonImpactEasySession(
          userId,
          plannedDate,
          RACE_WEEK_NON_IMPACT_MINUTES,
          nonImpactMachines,
          calibration.zones,
          null,
          null
        )
      );
    } else {
      const indoor = indoorLeft > 0;
      if (indoor) indoorLeft--;
      const strides = slot.role === "strides";
      sessions.push(
        buildEasySession(
          userId,
          plannedDate,
          strides ? RACE_WEEK_STRIDES_EASY_MINUTES : RACE_WEEK_FIRST_EASY_MINUTES,
          indoor,
          calibration,
          false,
          null,
          null,
          strides ? RACE_WEEK_STRIDE_REPS : null
        )
      );
    }
  });

  if (open.has(raceIndex) && raceOffset >= firstPlannableDay && raceOffset <= 6) {
    sessions.push(buildRaceSession(userId, addDays(weekStartDate, raceOffset), raceMode, calibration));
    slotIndices.push(raceIndex);
  }

  return {
    userId,
    weekStartDate,
    cycleWeekNumber: input.cycleWeekNumber,
    phase: input.phase,
    runsPerWeek: input.runsPerWeek,
    indoorRuns: Math.max(0, Math.min(input.indoorRuns, input.runsPerWeek)),
    nonImpactSessions: input.nonImpactSessions,
    sessions,
    slotIndices,
  };
}

// ─── Weekly architecture (spec §4 "Architecture hebdomadaire") ─────────────

/** A session's physiological role, independent of modality (running vs. non-impact). */
type Role = "easy" | "quality" | "long";

/** One session slot: its role plus which modality (running vs. non-impact) fills it. */
interface ArchSlot {
  modality: Modality;
  role: Role;
}

function runningArchitecture(runsPerWeek: number, isDecharge: boolean): Role[] {
  if (runsPerWeek <= 0) return [];
  if (runsPerWeek === 1) return ["long"];
  if (runsPerWeek === 2) return isDecharge ? ["easy", "long"] : ["quality", "long"];
  if (runsPerWeek === 3) return isDecharge ? ["easy", "easy", "long"] : ["easy", "quality", "long"];
  return isDecharge ? ["easy", "easy", "easy", "long"] : ["easy", "quality", "easy", "long"];
}

/**
 * Non-impact never carries the "long" role (spec's three templates are
 * facile/seuil/VO2max only) — it grows cardio volume alongside running's own
 * long run, rather than replacing it. Mirrors runningArchitecture's easy:quality
 * ratio otherwise.
 */
function nonImpactArchitecture(count: number, isDecharge: boolean): Role[] {
  if (count <= 0) return [];
  if (count === 1) return ["easy"];
  if (count === 2) return isDecharge ? ["easy", "easy"] : ["easy", "quality"];
  if (count === 3) return isDecharge ? ["easy", "easy", "easy"] : ["easy", "quality", "easy"];
  return isDecharge ? ["easy", "easy", "easy", "easy"] : ["easy", "quality", "easy", "quality"];
}

/**
 * Combines running and non-impact roles into one ordered slot list. The
 * (running-only) "long" role, if present, is always moved last — the day-
 * assignment logic below anchors it to the weekend by array position.
 */
function combinedArchitecture(runsPerWeek: number, nonImpactSessions: number, isDecharge: boolean): ArchSlot[] {
  const running = runningArchitecture(runsPerWeek, isDecharge).map((role) => ({
    modality: "running" as const,
    role,
  }));
  const nonImpact = nonImpactArchitecture(nonImpactSessions, isDecharge).map((role) => ({
    modality: "non_impact" as const,
    role,
  }));
  return [...running.filter((s) => s.role !== "long"), ...nonImpact, ...running.filter((s) => s.role === "long")];
}

/** The architecture role a kept session filled — a downgraded session still used up its original slot. */
function keptSessionRole(kind: SessionKind, downgradedFrom: SessionKind | null): Role {
  const original = downgradedFrom ?? kind;
  if (original === "threshold" || original === "vo2max") return "quality";
  if (original === "long" || original === "race") return "long";
  return "easy";
}

/** A slot still to plan, with its index in the full week architecture. */
interface OpenSlot {
  slot: ArchSlot;
  slotIndex: number;
}

/**
 * The architecture slots kept sessions (completed/skipped/past) haven't
 * already used up. Each kept session consumes a slot of its own modality —
 * its own slot_index when that still fits, else one with the same role, else
 * any (easy first): it was one of the week's sessions either way. Then the
 * one-hard-session-per-week rule applies across the whole week: once a kept
 * session counts as hard, or past the first remaining quality slot, quality
 * slots are demoted to easy.
 */
function openSlots(slots: ArchSlot[], kept: KeptSession[]): OpenSlot[] {
  const open = new Set(slots.map((_, i) => i));
  const openIndices = () => Array.from(open).sort((a, b) => a - b);

  for (const k of kept) {
    const role = keptSessionRole(k.kind, k.downgradedFrom);
    const fits = (i: number) => open.has(i) && slots[i].modality === k.modality;
    let idx: number | undefined =
      k.slotIndex != null && fits(k.slotIndex) && slots[k.slotIndex].role === role ? k.slotIndex : undefined;
    for (const r of [role, "easy", "quality", "long"] as const) {
      if (idx !== undefined) break;
      idx = openIndices().find((i) => fits(i) && slots[i].role === r);
    }
    if (idx !== undefined) open.delete(idx);
  }

  let hardBudget = Math.max(0, 1 - kept.filter((k) => k.countsAsHard).length);
  return openIndices().map((i) => {
    if (slots[i].role !== "quality") return { slot: slots[i], slotIndex: i };
    if (hardBudget > 0) {
      hardBudget--;
      return { slot: slots[i], slotIndex: i };
    }
    return { slot: { ...slots[i], role: "easy" }, slotIndex: i };
  });
}

/** Drops open slots that no remaining day can host — easy first, then quality; the long run goes last. */
function fitSlotsToDays(open: OpenSlot[], dayCount: number): OpenSlot[] {
  const result = [...open];
  while (result.length > dayCount) {
    for (const role of ["easy", "quality", "long"] as const) {
      const at = result.map((o) => o.slot.role).lastIndexOf(role);
      if (at !== -1) {
        result.splice(at, 1);
        break;
      }
    }
  }
  return result;
}

/**
 * Picks which available day (0=Mon..6=Sun) each slot lands on. Assumes
 * availableDays.length >= slots.length (validated by the caller). The long
 * run, if the architecture has one (always the last slot when it exists —
 * see combinedArchitecture), prefers a weekend day; the remaining slots are
 * spread as evenly as possible across the rest of the week, keeping their
 * chronological order in step with the slots array; and if the slot right
 * before the long run ends up adjacent to it, it's swapped for a
 * non-adjacent day when one is available — no two demanding days
 * back-to-back, per spec.
 */
function assignDaysToSlots(availableDays: number[], slots: ArchSlot[]): number[] {
  const sorted = Array.from(new Set(availableDays)).sort((a, b) => a - b);
  const n = slots.length;
  const hasLong = n > 0 && slots[n - 1].role === "long";

  // 1. Long run day (when there is one): prefer Saturday, then Sunday, else the latest available day.
  const longDay = hasLong ? (sorted.includes(5) ? 5 : sorted.includes(6) ? 6 : sorted[sorted.length - 1]) : undefined;

  // 2. Remaining slots share the remaining available days, spread evenly.
  const remainingPool = hasLong ? sorted.filter((d) => d !== longDay) : sorted;
  const remainingSlotCount = hasLong ? n - 1 : n;

  let chosenRemaining: number[];
  if (remainingSlotCount === 0) {
    chosenRemaining = [];
  } else if (remainingPool.length <= remainingSlotCount) {
    chosenRemaining = [...remainingPool];
  } else {
    // More available days than needed: snap evenly-spaced target positions
    // across the week to the closest still-available day.
    const targets = Array.from({ length: remainingSlotCount }, (_, i) =>
      Math.round(((i + 1) * 7) / (remainingSlotCount + 1))
    );
    const pool = [...remainingPool];
    chosenRemaining = targets.map((t) => {
      pool.sort((a, b) => Math.abs(a - t) - Math.abs(b - t));
      return pool.shift()!;
    });
    chosenRemaining.sort((a, b) => a - b);
  }

  const days = hasLong ? [...chosenRemaining, longDay!] : chosenRemaining;

  // 3. Avoid the slot right before "long" landing adjacent to it, when a
  //    non-adjacent day is available to take its place instead.
  if (hasLong && n >= 2) {
    const beforeLongIndex = n - 2;
    if (Math.abs(days[beforeLongIndex] - longDay!) === 1) {
      const usedElsewhere = new Set(days);
      const swapCandidate = days.slice(0, beforeLongIndex).find((d) => Math.abs(d - longDay!) !== 1);
      const poolCandidate = sorted.find(
        (d) => d !== longDay && !usedElsewhere.has(d) && Math.abs(d - longDay!) !== 1
      );
      const alternative = swapCandidate ?? poolCandidate;
      if (alternative !== undefined) {
        const swapIndex = days.indexOf(alternative);
        if (swapIndex !== -1 && swapIndex !== beforeLongIndex) {
          [days[beforeLongIndex], days[swapIndex]] = [days[swapIndex], days[beforeLongIndex]];
        } else if (swapIndex === -1) {
          days[beforeLongIndex] = alternative;
        }
      }
    }
  }

  return days;
}

/**
 * Cross-training rule: never let a hard non-impact session land next to a
 * hard running session — pair hard bike/assault-bike work with easy/long
 * running days instead. Best-effort: swaps a conflicting quality slot's day
 * with any non-quality slot's day that resolves the adjacency, when one
 * exists.
 */
function separateHardCrossModalityDays(slots: ArchSlot[], days: number[]): number[] {
  const result = [...days];
  const qualityIndices = slots.map((s, i) => i).filter((i) => slots[i].role === "quality");

  for (let a = 0; a < qualityIndices.length; a++) {
    for (let b = a + 1; b < qualityIndices.length; b++) {
      const ia = qualityIndices[a];
      const ib = qualityIndices[b];
      if (slots[ia].modality === slots[ib].modality) continue;
      if (Math.abs(result[ia] - result[ib]) !== 1) continue;

      const candidate = slots.findIndex(
        (s, i) => i !== ia && i !== ib && s.role !== "quality" && Math.abs(result[i] - result[ia]) !== 1
      );
      if (candidate !== -1) {
        [result[ib], result[candidate]] = [result[candidate], result[ib]];
      }
    }
  }

  return result;
}

/**
 * No run on the day after a long run: the legs need that day (and the
 * athlete's BJJ/strength work loads them too). If a non-impact session is in
 * the week, it takes that day — the bike is the right session for it.
 * Otherwise the run moves to a free available day, preferring one not next to
 * a long run, then the closest. Best-effort: when neither is possible the run
 * stays. Slots in `fixed` (manual day overrides) are never moved, and a move
 * that would put two hard sessions of different modalities side by side (see
 * separateHardCrossModalityDays) is skipped. A long day of -1 is the previous
 * week's Sunday long run, which makes this Monday a day after.
 */
function avoidRunAfterLongRun(
  slots: ArchSlot[],
  days: number[],
  plannableDays: number[],
  longDays: number[],
  fixed: Set<number>
): number[] {
  const afterDays = new Set(longDays.map((d) => d + 1).filter((d) => d >= 0 && d <= 6));
  const result = [...days];

  const hardNeighbourConflict = (i: number, day: number) =>
    slots[i].role === "quality" &&
    slots.some(
      (s, j) => j !== i && s.role === "quality" && s.modality !== slots[i].modality && Math.abs(result[j] - day) === 1
    );
  const nextToLong = (d: number) => longDays.some((l) => Math.abs(d - l) === 1);

  afterDays.forEach((after) => {
    const run = slots.findIndex((s, i) => s.modality === "running" && result[i] === after && !fixed.has(i));
    if (run === -1) return;

    const nonImpact = slots
      .map((_, j) => j)
      .filter((j) => slots[j].modality === "non_impact" && !fixed.has(j) && !afterDays.has(result[j]))
      .sort((a, b) => Number(slots[a].role === "quality") - Number(slots[b].role === "quality"));
    for (const j of nonImpact) {
      const runDay = result[j];
      if (hardNeighbourConflict(j, after) || hardNeighbourConflict(run, runDay)) continue;
      [result[run], result[j]] = [runDay, after];
      return;
    }

    const used = new Set(result);
    const free = plannableDays
      .filter((d) => !used.has(d) && !afterDays.has(d) && !longDays.includes(d) && !hardNeighbourConflict(run, d))
      .sort((a, b) => Number(nextToLong(a)) - Number(nextToLong(b)) || Math.abs(a - after) - Math.abs(b - after));
    if (free.length > 0) result[run] = free[0];
  });

  return result;
}

/**
 * Applies validated slot -> day overrides on top of the auto-computed
 * placement. Collisions (an override taking a day another slot was auto-
 * assigned to) are resolved by bumping the non-overridden slot to the
 * closest still-free available day.
 */
function applyDayOverrides(
  autoDays: number[],
  slotOverrides: Record<number, number> | undefined,
  availableDays: number[]
): number[] {
  if (!slotOverrides || Object.keys(slotOverrides).length === 0) return autoDays;

  const days = [...autoDays];
  const availableSet = new Set(availableDays);
  const overriddenIndices = new Set<number>();

  for (const [idxStr, day] of Object.entries(slotOverrides)) {
    const idx = Number(idxStr);
    if (idx < 0 || idx >= days.length) continue;
    if (!availableSet.has(day)) continue; // no longer available — caller drops these
    days[idx] = day;
    overriddenIndices.add(idx);
  }

  const used = new Set<number>();
  overriddenIndices.forEach((idx) => used.add(days[idx]));

  for (let i = 0; i < days.length; i++) {
    if (overriddenIndices.has(i)) continue;
    if (!used.has(days[i])) {
      used.add(days[i]);
      continue;
    }
    const candidates = availableDays.filter((d) => !used.has(d));
    candidates.sort((a, b) => Math.abs(a - days[i]) - Math.abs(b - days[i]));
    if (candidates.length > 0) {
      days[i] = candidates[0];
      used.add(days[i]);
    }
  }

  return days;
}

/**
 * Assigns indoor treadmill runs preferring easy, then quality, then long —
 * deterministic given a count. Never applies to non-impact sessions (there's
 * no treadmill-equivalent "indoor" flag for a bike/elliptical).
 */
function assignIndoor(slots: ArchSlot[], indoorRuns: number): boolean[] {
  const chosen = new Set<number>();
  for (const pref of ["easy", "quality", "long"] as const) {
    for (let i = 0; i < slots.length && chosen.size < indoorRuns; i++) {
      if (slots[i].modality === "running" && slots[i].role === pref) chosen.add(i);
    }
    if (chosen.size >= indoorRuns) break;
  }
  return slots.map((_, i) => chosen.has(i));
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Re-applies the subjective downgrade rules to a single already-planned
 * session — used when a fresh subjective_entries row is logged and might
 * affect a session already generated for the next 48h (spec §2). Returns
 * null when no downgrade applies.
 */
export function applyLiveDowngrade(params: {
  userId: string;
  plannedDate: Date;
  kind: SessionKind;
  modality: Modality;
  /** The session's own machine, when modality is non_impact — kept as-is on downgrade. */
  machine: NonImpactMachine | null;
  indoor: boolean;
  currentDurationMinutes: number;
  easyMinutes: number;
  calibration: AthleteCalibration;
  signal: SubjectiveSignal;
}): PlannedSession | null {
  const decision = decideDowngrade(params.kind, params.signal);
  if (decision.type === "none") return null;

  if (decision.type === "rest") {
    return buildRestSession(params.userId, params.plannedDate, params.kind, decision.reason);
  }

  if (decision.type === "toEasy") {
    if (params.modality === "non_impact") {
      // Pain/low-energy should push toward less impact, never back onto running.
      return buildNonImpactEasySession(
        params.userId,
        params.plannedDate,
        params.easyMinutes,
        params.machine ? [params.machine] : ["bike"],
        params.calibration.zones,
        params.kind,
        decision.reason
      );
    }
    const addStrides = shouldAddStrides(params.signal);
    return buildEasySession(
      params.userId,
      params.plannedDate,
      params.easyMinutes,
      params.indoor,
      params.calibration,
      addStrides,
      params.kind,
      decision.reason
    );
  }

  // shortenLong
  const minutes = Math.max(20, round5(params.currentDurationMinutes * decision.factor));
  return buildLongSession(
    params.userId,
    params.plannedDate,
    minutes,
    "continuous",
    params.indoor,
    params.calibration,
    params.kind,
    decision.reason
  );
}

export function buildWeekPlan(input: PlannerInput): WeekPlan {
  const {
    userId,
    weekStartDate,
    runsPerWeek,
    nonImpactSessions,
    nonImpactMachines,
    cycleWeekNumber,
    phase,
    qualityLevel,
    longRunMinutes,
    calibration,
    subjectiveEntries,
    availableDays,
    slotOverrides,
    keptSessions = [],
  } = input;

  // Race mode overrides durations and roles for the weeks around a race (race.ts);
  // the race week itself has its own placement.
  const raceMode = input.raceMode ?? null;
  if (raceMode?.position === "race") return buildRaceWeekPlan(input, raceMode);
  const reduction = raceMode?.position === "reduction";
  const recovery = raceMode?.position === "recovery";

  const indoorRuns = Math.max(0, Math.min(input.indoorRuns, runsPerWeek));
  const isDecharge = phase === "decharge" && !reduction && !recovery;

  // Quality-role rotation (spec §4bis): Seuil/VO2max alternate by cycle-week parity.
  // Shared across running and non-impact quality slots — same week, same theme.
  // The reduction week's one quality session is always the short threshold one.
  const role: "threshold" | "vo2max" = reduction || cycleWeekNumber % 2 === 1 ? "threshold" : "vo2max";
  const roleOccurrence = Math.floor((cycleWeekNumber - 1) / 2);
  const alternateVariant = roleOccurrence % 2 === 1 && !reduction;
  // No progression finish on a race-mode long run.
  const longVariant: SessionVariant = !raceMode && cycleWeekNumber % 2 === 0 ? "progression" : "continuous";

  // Duration anchors (spec §1). Shared by non-impact facile/endurance sessions too
  // (same duration as the equivalent run).
  const baseLongMinutes = longRunMinutes;
  const baseEasyMinutes = Math.max(20, round5(baseLongMinutes * 0.55));
  const longMinutesThisWeek =
    raceMode?.position === "peak"
      ? raceMode.peakLongRunMinutes
      : reduction
        ? REDUCTION_LONG_RUN_MINUTES
        : isDecharge
          ? Math.max(20, round5(baseLongMinutes * 0.7))
          : baseLongMinutes;
  const easyMinutesThisWeek = isDecharge ? Math.max(20, round5(baseEasyMinutes * 0.7)) : baseEasyMinutes;

  const architecture = raceModeArchitecture(
    combinedArchitecture(runsPerWeek, nonImpactSessions, isDecharge),
    raceMode
  );
  // Reduction/recovery: each easy slot's share of the week's volume target.
  const raceEasyMinutes = reduction || recovery ? raceModeEasyMinutesBySlot(input, architecture, raceMode!) : null;
  const easyMinutesFor = (slotIndex: number) =>
    raceEasyMinutes ? (raceEasyMinutes.get(slotIndex) ?? RACE_MODE_MIN_EASY_MINUTES) : easyMinutesThisWeek;
  const resolvedAvailableDays =
    availableDays.length >= architecture.length ? availableDays : [0, 1, 2, 3, 4, 5, 6];

  // Only the rest of the week gets planned: not before firstPlannableDay, not
  // on a day a kept session already holds, not in a slot one already used.
  const firstPlannableDay = Math.max(0, Math.min(7, input.firstPlannableDay ?? 0));
  const keptDays = new Set(keptSessions.map((k) => k.dayOffset));
  const plannableDays = resolvedAvailableDays.filter((d) => d >= firstPlannableDay && !keptDays.has(d));
  const open = fitSlotsToDays(openSlots(architecture, keptSessions), plannableDays.length);
  const slots = open.map((o) => o.slot);

  const openOverrides: Record<number, number> = {};
  open.forEach((o, pos) => {
    const day = slotOverrides?.[o.slotIndex];
    if (day !== undefined) openOverrides[pos] = day;
  });

  const autoDayOffsetsRaw = assignDaysToSlots(plannableDays, slots);
  const autoDayOffsets = separateHardCrossModalityDays(slots, autoDayOffsetsRaw);
  const overriddenDays = applyDayOverrides(autoDayOffsets, openOverrides, plannableDays);
  const fixedSlots = new Set(
    Object.entries(openOverrides)
      .filter(([, day]) => plannableDays.includes(day))
      .map(([pos]) => Number(pos))
  );
  const longPos = slots.findIndex((s) => s.role === "long");
  const keptLong = keptSessions.find(
    (k) => !k.skipped && k.kind !== "rest" && keptSessionRole(k.kind, k.downgradedFrom) === "long"
  );
  // The week after a race keeps running off its first two days, as if a long
  // run had been on Sunday and Monday: the non-impact sessions take them.
  const longDays = recovery
    ? [-1, 0]
    : [
        ...(input.previousWeekLongRunOnSunday ? [-1] : []),
        ...(keptLong ? [keptLong.dayOffset] : []),
        ...(longPos !== -1 ? [overriddenDays[longPos]] : []),
      ];
  const dayOffsets = avoidRunAfterLongRun(slots, overriddenDays, plannableDays, longDays, fixedSlots);
  const keptIndoorRuns = keptSessions.filter((k) => k.modality === "running" && k.indoor).length;
  const indoorFlags = assignIndoor(slots, Math.max(0, indoorRuns - keptIndoorRuns));

  const sessions: PlannedSession[] = slots.map((slot, i) => {
    const plannedDate = addDays(weekStartDate, dayOffsets[i]);
    const indoor = indoorFlags[i];
    const signal: SubjectiveSignal | null = findApplicableSignal(subjectiveEntries, plannedDate);
    const easyMinutes = easyMinutesFor(open[i].slotIndex);

    if (slot.modality === "non_impact") {
      if (slot.role === "easy") {
        const decision = decideDowngrade("easy", signal);
        if (decision.type === "rest") return buildRestSession(userId, plannedDate, "easy", decision.reason);
        return buildNonImpactEasySession(
          userId,
          plannedDate,
          easyMinutes,
          nonImpactMachines,
          calibration.zones,
          null,
          null
        );
      }

      // slot.role === "quality"
      const decision = decideDowngrade(role, signal);
      if (decision.type === "rest") return buildRestSession(userId, plannedDate, role, decision.reason);
      if (decision.type === "toEasy") {
        return buildNonImpactEasySession(
          userId,
          plannedDate,
          easyMinutes,
          nonImpactMachines,
          calibration.zones,
          role,
          decision.reason
        );
      }
      return role === "threshold"
        ? buildNonImpactThresholdSession(userId, plannedDate, qualityLevel, nonImpactMachines, calibration.zones)
        : buildNonImpactVo2maxSession(userId, plannedDate, qualityLevel, nonImpactMachines, calibration.zones);
    }

    if (slot.role === "long") {
      const decision = decideDowngrade("long", signal);
      if (decision.type === "rest") return buildRestSession(userId, plannedDate, "long", decision.reason);
      if (decision.type === "toEasy") {
        return buildEasySession(
          userId,
          plannedDate,
          easyMinutes,
          indoor,
          calibration,
          false,
          "long",
          decision.reason
        );
      }
      const minutes =
        decision.type === "shortenLong"
          ? Math.max(20, round5(longMinutesThisWeek * decision.factor))
          : longMinutesThisWeek;
      const reason = decision.type === "shortenLong" ? decision.reason : null;
      return buildLongSession(
        userId,
        plannedDate,
        minutes,
        longVariant,
        indoor,
        calibration,
        reason ? "long" : null,
        reason
      );
    }

    if (slot.role === "easy") {
      const decision = decideDowngrade("easy", signal);
      if (decision.type === "rest") return buildRestSession(userId, plannedDate, "easy", decision.reason);
      // No strides the week after a race: easy only.
      const addStrides = !recovery && shouldAddStrides(signal);
      return buildEasySession(
        userId,
        plannedDate,
        easyMinutes,
        indoor,
        calibration,
        addStrides,
        null,
        null
      );
    }

    // slot.role === "quality" (running)
    const decision = decideDowngrade(role, signal);
    if (decision.type === "rest") return buildRestSession(userId, plannedDate, role, decision.reason);
    if (decision.type === "toEasy") {
      const addStrides = shouldAddStrides(signal);
      return buildEasySession(
        userId,
        plannedDate,
        easyMinutes,
        indoor,
        calibration,
        addStrides,
        role,
        decision.reason
      );
    }

    if (role === "threshold") {
      const variant: SessionVariant = indoor ? "classic" : alternateVariant ? "fartlek" : "classic";
      return buildThresholdSession(userId, plannedDate, qualityLevel, variant, indoor, calibration, reduction);
    }
    const variant: SessionVariant = indoor ? "hills" : alternateVariant ? "hills" : "classic";
    return buildVo2maxSession(userId, plannedDate, qualityLevel, variant, indoor, calibration);
  });

  return {
    userId,
    weekStartDate,
    cycleWeekNumber,
    phase,
    runsPerWeek,
    indoorRuns,
    nonImpactSessions,
    sessions,
    slotIndices: open.map((o) => o.slotIndex),
  };
}
