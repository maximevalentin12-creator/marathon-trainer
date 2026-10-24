/**
 * Non-impact cardio session templates — an alternative to running that grows
 * cardio volume without extra joint/tendon load, and a fallback when pain is
 * reported. Mirrors the running roles (facile/seuil/VO2max: same
 * physiological purpose, different modality) built in rules.ts.
 */

import type { NonImpactMachine, PlannedSession, SessionKind } from "./types";
import { nonImpactHeartRateZones, nonImpactHrHint, type HeartRateZones } from "./zones";

export const NON_IMPACT_MACHINES: readonly NonImpactMachine[] = ["bike", "assault_bike", "elliptical"];

export function isNonImpactMachine(value: unknown): value is NonImpactMachine {
  return typeof value === "string" && (NON_IMPACT_MACHINES as readonly string[]).includes(value);
}

export const MACHINE_LABEL_FR: Record<NonImpactMachine, string> = {
  bike: "vélo d'appartement",
  assault_bike: "assault bike",
  elliptical: "élliptique",
};

// ─── "Why" notes — same plain-language register as the running ones ────────

const WHY_NON_IMPACT_EASY =
  "Travailler le cardio sans charge articulaire — même bénéfice aérobie, moins d'impact sur les tendons.";
const WHY_NON_IMPACT_THRESHOLD =
  "Augmenter la vitesse que tu peux tenir sur la durée, sans le choc de la course — le même effort contrôlé, sans charge sur les articulations.";
const WHY_NON_IMPACT_VO2MAX =
  "Habituer le cœur et les poumons à un effort très intense, par courtes doses — sans l'impact articulaire de la course, pour préserver tendons et articulations.";

/**
 * Which machine a given role prefers, when more than one is available.
 * Assault bike is best for short, very hard efforts (VO2max); a steadier
 * vélo/élliptique suits sustained work (facile, seuil).
 */
function pickMachine(role: "easy" | "threshold" | "vo2max", machines: NonImpactMachine[]): NonImpactMachine {
  const preference: NonImpactMachine[] =
    role === "vo2max" ? ["assault_bike", "bike", "elliptical"] : ["bike", "elliptical", "assault_bike"];
  return preference.find((m) => machines.includes(m)) ?? machines[0] ?? "bike";
}

function levelAt<T>(levels: ReadonlyArray<T>, level: number): T {
  return levels[Math.max(0, Math.min(level, levels.length - 1))];
}

// ─── Progression tables (mirrors rules.ts's THRESHOLD_LEVELS/VO2MAX_LEVELS shape) ──

/** "3-4 × 6-8 min sustained, 2-3 min easy recovery." */
const NON_IMPACT_THRESHOLD_LEVELS: ReadonlyArray<{ reps: number; workMin: number }> = [
  { reps: 3, workMin: 6 },
  { reps: 3, workMin: 7 },
  { reps: 3, workMin: 8 },
  { reps: 4, workMin: 6 },
  { reps: 4, workMin: 7 },
  { reps: 4, workMin: 8 },
  { reps: 4, workMin: 8 },
];

/** Assault bike: "6-10 × 1-2 min hard with equal or double recovery." */
const NON_IMPACT_VO2MAX_ASSAULT_LEVELS: ReadonlyArray<{ reps: number; workMin: number; recoveryFactor: number }> = [
  { reps: 6, workMin: 1, recoveryFactor: 2 },
  { reps: 7, workMin: 1, recoveryFactor: 2 },
  { reps: 8, workMin: 1, recoveryFactor: 2 },
  { reps: 8, workMin: 1, recoveryFactor: 1 },
  { reps: 8, workMin: 2, recoveryFactor: 1 },
  { reps: 9, workMin: 2, recoveryFactor: 1 },
  { reps: 10, workMin: 2, recoveryFactor: 1 },
];

/** Vélo/élliptique: "4-6 × 3 min", equal recovery. */
const NON_IMPACT_VO2MAX_STEADY_LEVELS: ReadonlyArray<{ reps: number; workMin: number }> = [
  { reps: 4, workMin: 3 },
  { reps: 4, workMin: 3 },
  { reps: 5, workMin: 3 },
  { reps: 5, workMin: 3 },
  { reps: 6, workMin: 3 },
  { reps: 6, workMin: 3 },
  { reps: 6, workMin: 3 },
];

// ─── Session builders ───────────────────────────────────────────────────────

function nonImpactWarmupCooldown(label: string, minutes: number, machineLabel: string, niZones: HeartRateZones) {
  return {
    label,
    durationMinutes: minutes,
    description: `${machineLabel[0].toUpperCase()}${machineLabel.slice(1)}, montée progressive en douceur`,
    zoneLabel: "Facile",
    heartRateHint: nonImpactHrHint(niZones, "facile"),
  };
}

export function buildNonImpactEasySession(
  userId: string,
  plannedDate: Date,
  minutes: number,
  machines: NonImpactMachine[],
  /** The athlete's running zones — shifted here for the bike. */
  zones: HeartRateZones,
  downgradedFrom: SessionKind | null,
  downgradeReason: string | null
): PlannedSession {
  const niZones = nonImpactHeartRateZones(zones);
  const machine = pickMachine("easy", machines);
  const machineLabel = MACHINE_LABEL_FR[machine];

  return {
    userId,
    plannedDate,
    kind: "easy",
    label: downgradedFrom ? `Cardio facile (adaptée, ${machineLabel})` : `Cardio facile (${machineLabel})`,
    variant: "plain",
    modality: "non_impact",
    indoor: false,
    inclinePercent: null,
    machine,
    targetDurationMinutes: minutes,
    targetDistanceKm: null,
    targetPaceSecondsPerKm: null,
    zoneSummary: `Facile (${machineLabel})`,
    steps: [
      {
        label: "Continu",
        durationMinutes: minutes,
        description: "Effort modéré et régulier, à l'aise pour parler — pilote au ressenti, la FC n'est qu'un repère",
        zoneLabel: "Facile",
        heartRateHint: nonImpactHrHint(niZones, "facile"),
      },
    ],
    whyNote: downgradeReason ? `${WHY_NON_IMPACT_EASY} (${downgradeReason})` : WHY_NON_IMPACT_EASY,
    zoneReference: [niZones.facile],
    stridesAdded: false,
    downgradedFrom,
    downgradeReason,
  };
}

export function buildNonImpactThresholdSession(
  userId: string,
  plannedDate: Date,
  qualityLevel: number,
  machines: NonImpactMachine[],
  zones: HeartRateZones
): PlannedSession {
  const niZones = nonImpactHeartRateZones(zones);
  const machine = pickMachine("threshold", machines);
  const machineLabel = MACHINE_LABEL_FR[machine];
  const { reps, workMin } = levelAt(NON_IMPACT_THRESHOLD_LEVELS, qualityLevel);
  const recoveryMin = workMin <= 7 ? 2 : 3;
  const warm = 8;
  const cool = 8;
  const corpsMin = reps * workMin + (reps - 1) * recoveryMin;

  return {
    userId,
    plannedDate,
    kind: "threshold",
    label: `Cardio : Seuil (${machineLabel})`,
    variant: "classic",
    modality: "non_impact",
    indoor: false,
    inclinePercent: null,
    machine,
    targetDurationMinutes: warm + corpsMin + cool,
    targetDistanceKm: null,
    targetPaceSecondsPerKm: null,
    zoneSummary: `Facile → Seuil → Facile (${machineLabel})`,
    steps: [
      nonImpactWarmupCooldown("Échauffement", warm, machineLabel, niZones),
      {
        label: "Corps de séance",
        durationMinutes: corpsMin,
        description: `${reps} × ${workMin} min effort soutenu (zone Seuil), récup ${recoveryMin} min zone Facile entre blocs`,
        zoneLabel: `Seuil (${machineLabel})`,
        heartRateHint: nonImpactHrHint(niZones, "seuil"),
      },
      nonImpactWarmupCooldown("Retour au calme", cool, machineLabel, niZones),
    ],
    whyNote: WHY_NON_IMPACT_THRESHOLD,
    zoneReference: [niZones.facile, niZones.seuil],
    stridesAdded: false,
    downgradedFrom: null,
    downgradeReason: null,
  };
}

export function buildNonImpactVo2maxSession(
  userId: string,
  plannedDate: Date,
  qualityLevel: number,
  machines: NonImpactMachine[],
  zones: HeartRateZones
): PlannedSession {
  const niZones = nonImpactHeartRateZones(zones);
  const machine = pickMachine("vo2max", machines);
  const machineLabel = MACHINE_LABEL_FR[machine];
  const warm = 8;
  const cool = 8;

  let reps: number;
  let workMin: number;
  let recoveryMin: number;
  let recoveryDescription: string;

  if (machine === "assault_bike") {
    const level = levelAt(NON_IMPACT_VO2MAX_ASSAULT_LEVELS, qualityLevel);
    reps = level.reps;
    workMin = level.workMin;
    recoveryMin = workMin * level.recoveryFactor;
    recoveryDescription = level.recoveryFactor >= 2 ? "récup double" : "récup égale";
  } else {
    const level = levelAt(NON_IMPACT_VO2MAX_STEADY_LEVELS, qualityLevel);
    reps = level.reps;
    workMin = level.workMin;
    recoveryMin = workMin;
    recoveryDescription = "récup égale";
  }

  const corpsMin = reps * workMin + (reps - 1) * recoveryMin;

  return {
    userId,
    plannedDate,
    kind: "vo2max",
    label: `Cardio : VO2max (${machineLabel})`,
    variant: "classic",
    modality: "non_impact",
    indoor: false,
    inclinePercent: null,
    machine,
    targetDurationMinutes: warm + corpsMin + cool,
    targetDistanceKm: null,
    targetPaceSecondsPerKm: null,
    zoneSummary: `Facile → Maximum (sensation) → Facile (${machineLabel})`,
    steps: [
      nonImpactWarmupCooldown("Échauffement", warm, machineLabel, niZones),
      {
        label: "Corps de séance",
        durationMinutes: corpsMin,
        description: `${reps} × ${workMin} min effort « très dur », récup ${recoveryMin} min zone Facile (${recoveryDescription})`,
        zoneLabel: `Maximum (sensation) — ${machineLabel}`,
        heartRateHint: "FC en fin de rép seulement, informative : " + nonImpactHrHint(niZones, "seuil"),
      },
      nonImpactWarmupCooldown("Retour au calme", cool, machineLabel, niZones),
    ],
    whyNote: WHY_NON_IMPACT_VO2MAX,
    zoneReference: [
      niZones.facile,
      niZones.seuil,
      niZones.maximum,
    ],
    stridesAdded: false,
    downgradedFrom: null,
    downgradeReason: null,
  };
}
