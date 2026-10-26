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
  RacePlanWeekInput,
  SessionKind,
  SessionStep,
  SessionVariant,
  SubjectiveSignal,
  WeekPlan,
} from "./types";
import { hrHint, type HeartRateZones } from "./zones";
import { RACE_PLAN_CONFIG } from "./config";
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

const WHY_SOLO_TEST =
  "Une mesure de forme, pas une course : elle réactualise tes allures pour la suite. Pars prudemment, tiens une allure régulière.";
const WHY_LONG_MP =
  "Habituer le corps à tenir l'allure marathon sur des jambes déjà fatiguées, sans dépasser ce que tu as déjà couru.";
const WHY_TEMPO =
  "Du temps passé à l'allure visée, en continu : c'est ce qui rend l'allure de course familière le jour J.";
const WHY_REMINDER =
  "Quelques rappels courts pour garder le rythme en mémoire sans fatigue : l'affûtage ne se gâche pas avec une séance dure.";

/** The race's own note. The 15th-km cue only fits a long race; shorter ones hold until the last 3 km. */
function whyRace(distanceKm: number): string {
  const hold = distanceKm > 15 ? "jusqu'au 15e km" : "jusqu'aux 3 derniers km";
  return `Pas d'objectif de temps : pars dans ta zone facile et tiens-la ${hold}, accélère seulement si tout va bien. Bois à chaque ravitaillement.`;
}

// ─── Treadmill helpers (spec §4bis — min 1% incline rule) ───────────────────

/** One continuous easy block. Treadmill stays at 1–2 % — varied inclines belong to hill sessions only. */
function continuousStep(
  minutes: number,
  indoor: boolean,
  zones: HeartRateZones,
  description = "Conversation aisée du début à la fin"
): SessionStep {
  return {
    label: "Continu",
    durationMinutes: minutes,
    description: indoor ? `${description} — tapis à 1–2 % d'inclinaison` : description,
    zoneLabel: "Facile",
    heartRateHint: hrHint(zones, "facile"),
  };
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
  return [continuousStep(minutes, indoor, zones)];
}

function buildLongSteps(
  minutes: number,
  variant: SessionVariant,
  indoor: boolean,
  zones: HeartRateZones
): SessionStep[] {
  if (variant !== "progression") return [continuousStep(minutes, indoor, zones)];

  const finalMin = Math.max(5, round5(minutes * 0.12));
  const baseMin = minutes - finalMin;
  const baseSteps = [continuousStep(baseMin, indoor, zones, "Conversation aisée")];
  const finalStep: SessionStep = {
    label: "Fin de séance",
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
  // A race-based threshold pace (paces.ts, heuristic) wins over the 10K-reference offsets.
  const racePace = cal.thresholdPaceSecPerKm;
  const paceHint = racePace
    ? `≈${fmtPace(racePace - 5)}–${fmtPace(racePace + 5)}/km`
    : `≈${fmtPace(paceRef + 3)}–${fmtPace(paceRef + 13)}/km`;
  const warm = THRESHOLD_WARMUP_MINUTES;
  const cool = THRESHOLD_COOLDOWN_MINUTES;
  const easyPace = cal.easyPaceSecPerKm;
  // Midpoint of the displayed range above — same value already used as targetPaceSecondsPerKm.
  const thresholdPace = racePace ?? paceRef + 8;

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
          ...(cal.vo2maxPaceSecPerKm ? { paceHint: `≈${fmtPace(cal.vo2maxPaceSecPerKm)}/km (allure 5 km)` } : {}),
        };

  // Hills (treadmill incline or real hill) cover less ground for the same effort than flat
  // running — without a real gradient model that would be speculative, so no distance estimate.
  const distanceKm =
    variant === "hills"
      ? null
      : stepKm(warm, cal.easyPaceSecPerKm) +
        stepKm(reps * workMin, cal.vo2maxPaceSecPerKm ?? cal.paceReferenceSecPerKm + VO2MAX_PACE_ADJUSTMENT_SEC_PER_KM) +
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
    targetPaceSecondsPerKm: cal.thresholdPaceSecPerKm ?? cal.paceReferenceSecPerKm + 8,
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
    label: race.soloTest ? `Test solo : ${race.raceName}` : `Course : ${race.raceName}`,
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
        description: race.soloTest
          ? `${km} km en solo, allure régulière et contrôlée — départ prudent, tu peux accélérer sur la fin si ça va`
          : `${km} km — départ en zone Facile, accélération seulement en fin de course si tout va bien`,
        zoneLabel: "Facile",
        heartRateHint: hrHint(cal.zones, "facile"),
      },
    ],
    whyNote: race.soloTest ? WHY_SOLO_TEST : whyRace(race.distanceKm),
    zoneReference: [cal.zones.facile],
    stridesAdded: false,
    downgradedFrom: null,
    downgradeReason: null,
  };
}

// ─── Race-plan sessions (backward race planner, racePlan.ts) ───────────────

/**
 * Long run with marathon-pace work. Specific phase: easy warm-up, `reps` × `kmEach` km at MP with 1 km easy
 * between, easy cool-down. Development phase (`finish`): easy running, then one MP segment closing the run.
 * MP km × MP pace + 30 min easy must fit in the run — the work shrinks until it does (and the note says so);
 * with no room for even 2 km it is a plain long run.
 */
function buildMpLongSession(
  userId: string,
  plannedDate: Date,
  minutes: number,
  block: { reps: number; kmEach: number; finish?: boolean },
  indoor: boolean,
  cal: AthleteCalibration,
  mpPace: number
): PlannedSession {
  const easyPace = cal.easyPaceSecPerKm;
  const recoveryKm = 1;
  const cooldownMin = 10;
  const minEasy = RACE_PLAN_CONFIG.mpBlock.minEasyMin;
  const reps = block.finish ? 1 : block.reps;
  const workMinutes = (km: number) => (km * reps * mpPace) / 60;

  let kmEach = block.kmEach;
  while (kmEach >= 2 && workMinutes(kmEach) + minEasy > minutes) kmEach--;
  if (kmEach < 2) {
    return buildLongSession(userId, plannedDate, minutes, "continuous", indoor, cal, null, null);
  }
  const shrunk = kmEach < block.kmEach;
  const mpKm = kmEach * reps;

  const steps: SessionStep[] = [];
  if (block.finish) {
    const easyMin = Math.round(minutes - workMinutes(kmEach));
    steps.push({
      label: "Facile",
      durationMinutes: easyMin,
      description: indoor ? "Tapis à 1 % d'inclinaison minimum, conversation aisée" : "Conversation aisée, régulier",
      zoneLabel: "Facile",
      heartRateHint: hrHint(cal.zones, "facile"),
    });
    steps.push({
      label: "Finale — allure marathon",
      durationMinutes: Math.round(workMinutes(kmEach)),
      description: `${kmEach} km à allure marathon pour finir, régulier et relâché`,
      zoneLabel: "Allure marathon",
      heartRateHint: hrHint(cal.zones, "aerobie"),
      paceHint: `≈${fmtPace(mpPace)}/km`,
    });
  } else {
    const warmupMin = Math.max(15, Math.round(minutes - workMinutes(kmEach) - ((reps - 1) * recoveryKm * easyPace) / 60 - cooldownMin));
    steps.push({ ...warmupStep(warmupMin, indoor, cal.zones), label: "Échauffement facile" });
    for (let r = 1; r <= reps; r++) {
      steps.push({
        label: `Bloc ${r}/${reps} — allure marathon`,
        durationMinutes: Math.round((kmEach * mpPace) / 60),
        description: `${kmEach} km à allure marathon, régulier et relâché`,
        zoneLabel: "Allure marathon",
        heartRateHint: hrHint(cal.zones, "aerobie"),
        paceHint: `≈${fmtPace(mpPace)}/km`,
      });
      if (r < reps) {
        steps.push({
          label: "Récupération",
          durationMinutes: Math.round((recoveryKm * easyPace) / 60),
          description: `${recoveryKm} km facile`,
          zoneLabel: "Facile",
          heartRateHint: hrHint(cal.zones, "facile"),
        });
      }
    }
    steps.push(cooldownStep(cooldownMin, indoor, cal.zones));
  }

  const km = mpKm + stepKm(minutes - (mpKm * mpPace) / 60, easyPace);
  return {
    userId,
    plannedDate,
    kind: "long",
    label: block.finish
      ? `Longue avec finale de ${kmEach} km allure marathon`
      : `Longue avec ${reps} × ${kmEach} km allure marathon`,
    variant: "mp_blocks",
    modality: "running",
    indoor,
    inclinePercent: indoor ? 1 : null,
    machine: null,
    targetDurationMinutes: minutes,
    targetDistanceKm: Math.round(km * 10) / 10,
    targetPaceSecondsPerKm: easyPace,
    zoneSummary: "Facile → Allure marathon" + (block.finish ? "" : " → Facile"),
    steps,
    whyNote: shrunk
      ? `${WHY_LONG_MP} (Bloc réduit à ${mpKm} km : ${block.reps * block.kmEach} km à allure marathon + ${minEasy} min faciles ne tenaient pas dans ${minutes} min.)`
      : WHY_LONG_MP,
    zoneReference: [cal.zones.facile, cal.zones.aerobie],
    stridesAdded: false,
    downgradedFrom: null,
    downgradeReason: null,
  };
}

/** Continuous tempo at marathon or half-marathon pace — a threshold-slot session, paced by the race rather than by HR. */
function buildPaceTempoSession(
  userId: string,
  plannedDate: Date,
  tempoKm: number,
  pace: number,
  paceName: string,
  indoor: boolean,
  cal: AthleteCalibration
): PlannedSession {
  const warm = 10;
  const cool = 10;
  const tempoMin = Math.round((tempoKm * pace) / 60);
  const km = stepKm(warm + cool, cal.easyPaceSecPerKm) + tempoKm;
  return {
    userId,
    plannedDate,
    kind: "threshold",
    label: `Qualité : Tempo allure ${paceName}`,
    variant: "continuous",
    modality: "running",
    indoor,
    inclinePercent: indoor ? 1 : null,
    machine: null,
    targetDurationMinutes: warm + tempoMin + cool,
    targetDistanceKm: Math.round(km * 10) / 10,
    targetPaceSecondsPerKm: pace,
    zoneSummary: `Facile → Allure ${paceName} → Facile`,
    steps: [
      warmupStep(warm, indoor, cal.zones),
      {
        label: "Corps de séance",
        durationMinutes: tempoMin,
        description: `${tempoKm} km en continu à allure ${paceName}`,
        zoneLabel: `Allure ${paceName}`,
        heartRateHint: hrHint(cal.zones, "aerobie"),
        paceHint: `≈${fmtPace(pace)}/km`,
      },
      cooldownStep(cool, indoor, cal.zones),
    ],
    whyNote: WHY_TEMPO,
    zoneReference: [cal.zones.facile, cal.zones.aerobie],
    stridesAdded: false,
    downgradedFrom: null,
    downgradeReason: null,
  };
}

/** Appends short race-pace reminders (and strides when asked) to an easy session; it stays an easy one. */
function withPaceReminder(
  session: PlannedSession,
  reps: number,
  kmEach: number,
  pace: number | undefined,
  cal: AthleteCalibration,
  strides: boolean
): PlannedSession {
  const recoveryMin = 2;
  const reminderMin = pace ? Math.round(reps * ((kmEach * pace) / 60) + (reps - 1) * recoveryMin) : reps * 5;
  const steps: SessionStep[] = [
    ...session.steps,
    {
      label: "Rappels d'allure",
      durationMinutes: reminderMin,
      description: `${reps} × ${kmEach} km à l'allure de course, récup ${recoveryMin} min de trot — court et facile`,
      zoneLabel: "Allure de course",
      heartRateHint: hrHint(cal.zones, "aerobie"),
      ...(pace ? { paceHint: `≈${fmtPace(pace)}/km` } : {}),
    },
  ];
  if (strides) steps.push(stridesStep(4));
  return {
    ...session,
    label: "Facile avec rappels d'allure",
    steps,
    targetDurationMinutes: session.targetDurationMinutes + reminderMin,
    zoneSummary: "Facile → Allure de course",
    whyNote: WHY_REMINDER,
    zoneReference: [cal.zones.facile, cal.zones.aerobie],
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
/** Upper bound of an easy run in a race week sized from the plan's km. */
const RACE_WEEK_MAX_EASY_MINUTES = 60;
const RACE_WEEK_STRIDE_REPS = 4;
const RACE_WEEK_NON_IMPACT_MINUTES = 30;
const RACE_WEEK_REST_DAYS_BEFORE = 2;
/** A kept long run stays at least this many days before the race. */
const RACE_WEEK_LONG_RUN_DAYS_BEFORE = 4;

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
type RaceWeekRole = "easy" | "strides" | "race" | "long";

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
function raceWeekArchitecture(runsPerWeek: number, nonImpactSessions: number, withLong = false): RaceWeekSlot[] {
  const easyRunCount = Math.min(2, Math.max(0, runsPerWeek - 1 - (withLong ? 1 : 0)));
  const easyRuns = (["easy", "strides"] as const).slice(2 - easyRunCount);
  return [
    ...(withLong ? [{ modality: "running" as const, role: "long" as const }] : []),
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
  // A race under a half marathon keeps the week's long run when a day at least 4 days before the race is free.
  const withLong = (raceMode.raceWeekLongRunMinutes ?? 0) > 0 && input.runsPerWeek >= 3;
  const architecture = raceWeekArchitecture(input.runsPerWeek, input.nonImpactSessions, withLong);
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
            .find(
              (i) =>
                architecture[i].modality === k.modality &&
                architecture[i].role !== "race" &&
                (k.kind === "long") === (architecture[i].role === "long")
            );
    if (idx !== undefined) open.delete(idx);
  }
  const openList = Array.from(open).sort((a, b) => a - b);

  const candidates = Array.from(new Set(input.availableDays))
    .filter((d) => d >= firstPlannableDay && d < raceOffset - RACE_WEEK_REST_DAYS_BEFORE && !keptDays.has(d))
    .sort((a, b) => a - b);
  const afterLong = new Set<number>(input.previousWeekLongRunOnSunday ? [0] : []);

  // The long run, if kept: the earliest free day at least 4 days before the race; no slot, no long run.
  const longSlot = openList.find((i) => architecture[i].role === "long");
  const longDay =
    longSlot === undefined ? undefined : candidates.find((d) => d <= raceOffset - RACE_WEEK_LONG_RUN_DAYS_BEFORE);
  if (longDay !== undefined) afterLong.add(longDay + 1);
  const freeCandidates = candidates.filter((d) => d !== longDay);

  const runSlots = openList.filter(
    (i) => architecture[i].modality === "running" && architecture[i].role !== "race" && architecture[i].role !== "long"
  );
  const runDays = pickSpreadDays(
    freeCandidates.filter((d) => !afterLong.has(d)),
    runSlots.length
  );
  const placedRuns = runSlots.slice(runSlots.length - runDays.length);
  const nonImpactSlots = openList.filter((i) => architecture[i].modality === "non_impact");
  const nonImpactDays = freeCandidates
    .filter((d) => !runDays.includes(d))
    .sort((a, b) => Number(afterLong.has(b)) - Number(afterLong.has(a)) || a - b)
    .slice(0, nonImpactSlots.length);
  const placedNonImpact = nonImpactSlots.slice(0, nonImpactDays.length);

  // Manual day overrides can move the sessions before the race, within the same allowed days.
  const beforeRace = [...(longDay !== undefined ? [longSlot!] : []), ...placedRuns, ...placedNonImpact];
  const overridesByPos: Record<number, number> = {};
  beforeRace.forEach((slotIndex, pos) => {
    const day = slotOverrides?.[slotIndex];
    if (day !== undefined) overridesByPos[pos] = day;
  });
  const days = applyDayOverrides(
    [...(longDay !== undefined ? [longDay] : []), ...runDays, ...nonImpactDays],
    overridesByPos,
    candidates
  );

  const keptIndoorRuns = keptSessions.filter((k) => k.modality === "running" && k.indoor).length;
  let indoorLeft = Math.max(0, Math.min(input.indoorRuns, input.runsPerWeek) - keptIndoorRuns);

  // Easy-run length: the fixed 30 / 20 min, or — when the plan gives the week's running km — what is left
  // of it after the long run, shared between the easy runs.
  let firstEasyMinutes = RACE_WEEK_FIRST_EASY_MINUTES;
  let stridesEasyMinutes = RACE_WEEK_STRIDES_EASY_MINUTES;
  if (raceMode.trainingKm !== undefined && runDays.length > 0) {
    const longKm = longDay !== undefined ? stepKm(raceMode.raceWeekLongRunMinutes ?? 0, calibration.easyPaceSecPerKm) : 0;
    const perRunKm = Math.max(0, raceMode.trainingKm - longKm) / runDays.length;
    const minutes = Math.max(
      RACE_MODE_MIN_EASY_MINUTES,
      Math.min(RACE_WEEK_MAX_EASY_MINUTES, round5((perRunKm * calibration.easyPaceSecPerKm) / 60))
    );
    firstEasyMinutes = stridesEasyMinutes = minutes;
  }

  const sessions: PlannedSession[] = [];
  const slotIndices: number[] = [];
  beforeRace.forEach((slotIndex, pos) => {
    const slot = architecture[slotIndex];
    const plannedDate = addDays(weekStartDate, days[pos]);
    const decision = decideDowngrade(
      slot.role === "long" ? "long" : "easy",
      findApplicableSignal(subjectiveEntries, plannedDate)
    );
    slotIndices.push(slotIndex);
    if (decision.type === "rest") {
      sessions.push(buildRestSession(userId, plannedDate, "easy", decision.reason));
    } else if (slot.role === "long") {
      const minutes = raceMode.raceWeekLongRunMinutes!;
      sessions.push(
        decision.type === "toEasy"
          ? buildEasySession(userId, plannedDate, round5(minutes * 0.55), false, calibration, false, "long", decision.reason)
          : buildLongSession(
              userId,
              plannedDate,
              decision.type === "shortenLong" ? Math.max(20, round5(minutes * decision.factor)) : minutes,
              "continuous",
              false,
              calibration,
              null,
              null
            )
      );
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
      const easy = buildEasySession(
        userId,
        plannedDate,
        strides ? stridesEasyMinutes : firstEasyMinutes,
        indoor,
        calibration,
        false,
        null,
        null,
        strides ? RACE_WEEK_STRIDE_REPS : null
      );
      // The first easy run carries two short race-pace reminders when the plan knows the pace.
      sessions.push(
        !strides && raceMode.reminderPaceSecPerKm
          ? withPaceReminder(easy, 2, 1, raceMode.reminderPaceSecPerKm, calibration, false)
          : easy
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
  if (runsPerWeek === 4) return isDecharge ? ["easy", "easy", "easy", "long"] : ["easy", "quality", "easy", "long"];
  return isDecharge
    ? ["easy", "easy", "easy", "easy", "long"]
    : ["easy", "quality", "easy", "easy", "long"];
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

/** Rough km of one quality session (warm-up and cool-down included), growing with its level — only used to size the easy runs from a km target. */
const PLAN_QUALITY_KM_BASE = 8;
const PLAN_EASY_MIN_MINUTES = RACE_PLAN_CONFIG.easyRunFloorMin;
const PLAN_EASY_MAX_MINUTES = 80;

const PLAN_QUALITY_KEYS: ReadonlyArray<RacePlanWeekInput["keySession"]> = ["threshold", "vo2max", "mp_tempo", "race_pace"];

/**
 * Race-plan weeks: keeps the quality slots only when the plan wants a quality
 * session, and the long slot only when it has a long run. A mp_reminder week
 * returns the index of the (running) slot that carries the reminders.
 */
function planArchitecture(
  base: ArchSlot[],
  plan: RacePlanWeekInput
): { slots: ArchSlot[]; reminderSlot: number } {
  const wantsQuality = PLAN_QUALITY_KEYS.includes(plan.keySession);
  let reminderSlot = -1;
  const slots = base.map((s, i) => {
    if (s.role === "quality" && !wantsQuality) {
      if (plan.keySession === "mp_reminder" && s.modality === "running" && reminderSlot === -1) reminderSlot = i;
      return { ...s, role: "easy" as const };
    }
    if (s.role === "long" && plan.longRunMin <= 0) return { ...s, role: "easy" as const };
    return s;
  });
  return { slots, reminderSlot };
}

/** Minutes of each easy slot so the week lands near plan.targetKm once the long run and quality are counted. */
function planEasyMinutes(slots: ArchSlot[], plan: RacePlanWeekInput, easyPace: number): number {
  const runningEasy = slots.filter((s) => s.modality === "running" && s.role === "easy").length;
  const runningQuality = slots.filter((s) => s.modality === "running" && s.role === "quality").length;
  const longKm = slots.some((s) => s.role === "long") ? stepKm(plan.longRunMin, easyPace) : 0;
  const easyKm = Math.max(0, plan.targetKm - longKm - runningQuality * (PLAN_QUALITY_KM_BASE + plan.qualityLevel));
  const minutes = runningEasy > 0 ? ((easyKm / runningEasy) * easyPace) / 60 : PLAN_EASY_MIN_MINUTES;
  return Math.max(PLAN_EASY_MIN_MINUTES, Math.min(PLAN_EASY_MAX_MINUTES, round5(minutes)));
}

/** French note on a quality session replaced by an easy run because no day keeps it off the long run's neighbours. */
const QUALITY_NEXT_TO_LONG_NOTE =
  "Séance de qualité remplacée par un footing facile avec lignes droites : avec tes jours disponibles, elle tomberait la veille ou le lendemain de la sortie longue.";

/**
 * Day rules, applied after the usual placement (race-plan limits only when a plan is given):
 * - quality stays inside [qualityFromDay, qualityUntilDay] (post-race easy days, pre-race window) and is
 *   never the day before or after the long run;
 * - the long run stays inside [longRunFromDay, longRunUntilDay].
 * A misplaced session swaps days with an easy run that fits, or moves to a free available day; when
 * neither exists a quality session becomes an easy run with strides (its index is returned, for the
 * note) and a long run becomes an easy run. Mutates `slots` and `days`.
 *
 * `outsideLongDays` are long runs not in `slots` (last Sunday's, or one already done this week).
 */
function enforcePlanDayLimits(
  slots: ArchSlot[],
  days: number[],
  plannableDays: number[],
  outsideLongDays: number[],
  plan: RacePlanWeekInput | null
): Set<number> {
  const qualityFits = (d: number) => d >= (plan?.qualityFromDay ?? 0) && d <= (plan?.qualityUntilDay ?? 6);
  const longFits = (d: number) => d >= (plan?.longRunFromDay ?? 0) && d <= (plan?.longRunUntilDay ?? 6);
  const longDays = () => [
    ...outsideLongDays,
    ...slots.flatMap((s, i) => (s.role === "long" && s.modality === "running" ? [days[i]] : [])),
  ];
  const nextToLong = (d: number) => longDays().some((l) => Math.abs(d - l) === 1);
  const qualityOk = (d: number) => qualityFits(d) && !nextToLong(d);

  /** Moves slot i onto a day satisfying `fits`: swap with an easy slot, else a free available day. */
  const relocate = (i: number, fits: (d: number) => boolean, swapFits: (d: number) => boolean = () => true): boolean => {
    if (fits(days[i])) return true;
    const j = slots.findIndex(
      (s, k) => k !== i && s.role === "easy" && s.modality === slots[i].modality && fits(days[k]) && swapFits(days[i])
    );
    if (j !== -1) {
      [days[i], days[j]] = [days[j], days[i]];
      return true;
    }
    const free = plannableDays.filter((d) => !days.includes(d) && fits(d)).sort((a, b) => a - b)[0];
    if (free !== undefined) {
      days[i] = free;
      return true;
    }
    return false;
  };

  // Long run first: the quality placement below depends on where it ends up.
  slots.forEach((s, i) => {
    if (s.role === "long" && s.modality === "running" && !relocate(i, longFits)) slots[i] = { ...s, role: "easy" };
  });

  const downgraded = new Set<number>();
  slots.forEach((s, i) => {
    if (s.role !== "quality") return;
    // A quality session moved off its day must not land its easy partner on a day the long run needs.
    if (s.modality === "running" ? !relocate(i, qualityOk, longFits) : !relocate(i, qualityFits)) {
      slots[i] = { ...s, role: "easy" };
      // Only the adjacency case gets the note; a day-window miss (post-race easy days, pre-race window) is silent.
      if (s.modality === "running" && qualityFits(days[i])) downgraded.add(i);
    }
  });
  return downgraded;
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
  const racePlan = input.racePlan ?? null;
  if (raceMode?.position === "race") return buildRaceWeekPlan(input, raceMode);
  const reduction = raceMode?.position === "reduction";
  const recovery = raceMode?.position === "recovery";

  const indoorRuns = Math.max(0, Math.min(input.indoorRuns, runsPerWeek));
  // A race plan carries its own deload and taper in its km and long-run numbers.
  const isDecharge = phase === "decharge" && !reduction && !recovery && !racePlan;

  // Quality-role rotation (spec §4bis): Seuil/VO2max alternate by cycle-week parity.
  // Shared across running and non-impact quality slots — same week, same theme.
  // The reduction week's one quality session is always the short threshold one.
  const role: "threshold" | "vo2max" = racePlan
    ? racePlan.keySession === "vo2max"
      ? "vo2max"
      : "threshold"
    : reduction || cycleWeekNumber % 2 === 1
      ? "threshold"
      : "vo2max";
  const roleOccurrence = Math.floor((cycleWeekNumber - 1) / 2);
  const alternateVariant = roleOccurrence % 2 === 1 && !reduction;
  // No progression finish on a race-mode long run.
  const longVariant: SessionVariant =
    !raceMode && !racePlan && cycleWeekNumber % 2 === 0 ? "progression" : "continuous";

  // Duration anchors (spec §1). Shared by non-impact facile/endurance sessions too
  // (same duration as the equivalent run).
  const baseLongMinutes = longRunMinutes;
  const baseEasyMinutes = Math.max(20, round5(baseLongMinutes * 0.55));
  const longMinutesThisWeek = racePlan
    ? racePlan.longRunMin
    : raceMode?.position === "peak"
      ? raceMode.peakLongRunMinutes
      : reduction
        ? REDUCTION_LONG_RUN_MINUTES
        : isDecharge
          ? Math.max(20, round5(baseLongMinutes * 0.7))
          : baseLongMinutes;
  const easyMinutesThisWeek = isDecharge ? Math.max(20, round5(baseEasyMinutes * 0.7)) : baseEasyMinutes;

  const fullArchitecture = combinedArchitecture(runsPerWeek, nonImpactSessions, isDecharge);
  const planned = racePlan ? planArchitecture(fullArchitecture, racePlan) : null;
  const architecture = planned ? planned.slots : raceModeArchitecture(fullArchitecture, raceMode);
  // Reduction/recovery: each easy slot's share of the week's volume target.
  const raceEasyMinutes = reduction || recovery ? raceModeEasyMinutesBySlot(input, architecture, raceMode!) : null;
  const planEasy = racePlan ? planEasyMinutes(architecture, racePlan, calibration.easyPaceSecPerKm) : 0;
  const easyMinutesFor = (slotIndex: number) =>
    racePlan
      ? planEasy
      : raceEasyMinutes
        ? (raceEasyMinutes.get(slotIndex) ?? RACE_MODE_MIN_EASY_MINUTES)
        : easyMinutesThisWeek;
  const resolvedAvailableDays =
    availableDays.length >= architecture.length ? availableDays : [0, 1, 2, 3, 4, 5, 6];

  // Only the rest of the week gets planned: not before firstPlannableDay, not
  // on a day a kept session already holds, not in a slot one already used.
  const firstPlannableDay = Math.max(0, Math.min(7, input.firstPlannableDay ?? 0));
  const keptDays = new Set(keptSessions.map((k) => k.dayOffset));
  const plannableDays = resolvedAvailableDays.filter((d) => d >= firstPlannableDay && !keptDays.has(d));
  const open = fitSlotsToDays(openSlots(architecture, keptSessions), plannableDays.length);
  // Copies: the day limits below may turn a slot into an easy one.
  const slots = open.map((o) => ({ ...o.slot }));

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
  const placementDowngraded = enforcePlanDayLimits(
    slots,
    dayOffsets,
    plannableDays,
    [...(input.previousWeekLongRunOnSunday ? [-1] : []), ...(keptLong ? [keptLong.dayOffset] : [])],
    racePlan
  );
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
      const mpPace = calibration.marathonPaceSecPerKm;
      // Marathon-pace blocks only on an unshortened long run — a downgraded day drops them.
      if (racePlan?.longRunMpBlock && mpPace && !reason) {
        return buildMpLongSession(userId, plannedDate, minutes, racePlan.longRunMpBlock, indoor, calibration, mpPace);
      }
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
      const addStrides = !recovery && (shouldAddStrides(signal) || racePlan?.keySession === "strides");
      // A quality session that couldn't keep off the long run's neighbouring days: easy + strides, with the reason.
      if (placementDowngraded.has(i)) {
        return buildEasySession(
          userId,
          plannedDate,
          easyMinutes,
          indoor,
          calibration,
          true,
          role,
          QUALITY_NEXT_TO_LONG_NOTE
        );
      }
      const easy = buildEasySession(userId, plannedDate, easyMinutes, indoor, calibration, addStrides, null, null);
      // Taper week: the plan's quality slot becomes an easy run with short race-pace reminders.
      return planned && open[i].slotIndex === planned.reminderSlot
        ? withPaceReminder(
            easy,
            3,
            1,
            calibration.marathonPaceSecPerKm ?? calibration.halfPaceSecPerKm,
            calibration,
            true
          )
        : easy;
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

    const tempoPace =
      racePlan?.keySession === "mp_tempo"
        ? calibration.marathonPaceSecPerKm
        : racePlan?.keySession === "race_pace"
          ? calibration.halfPaceSecPerKm
          : undefined;
    if (tempoPace) {
      const tempoKm = Math.min(14, 6 + Math.round(racePlan!.qualityLevel * 1.5));
      return buildPaceTempoSession(
        userId,
        plannedDate,
        tempoKm,
        tempoPace,
        racePlan!.keySession === "mp_tempo" ? "marathon" : "semi",
        indoor,
        calibration
      );
    }

    if (role === "threshold") {
      const variant: SessionVariant = indoor ? "classic" : alternateVariant ? "fartlek" : "classic";
      return buildThresholdSession(userId, plannedDate, qualityLevel, variant, indoor, calibration, reduction || racePlan?.phase === "taper");
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
