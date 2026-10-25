// French wording for the race plan screens: phase names, one-sentence "why" per phase, key sessions.
// Plain language, no jargon. Pure and client-safe.

import type { RaceKeySession, RacePhase } from "./racePlan";

export const PHASE_LABEL_FR: Record<RacePhase, string> = {
  recovery: "Récupération",
  base: "Base",
  development: "Développement",
  specific: "Préparation spécifique",
  taper: "Affûtage",
  race: "Semaine de course",
};

/** One sentence per phase: what the weeks are for. */
export const PHASE_WHY_FR: Record<RacePhase, string> = {
  recovery: "Ton corps digère la dernière course : footings faciles seulement, sans objectif de volume.",
  base: "On reconstruit le volume et l'habitude de courir régulièrement, sans forcer.",
  development: "On ajoute de l'endurance et quelques séances plus soutenues, avec des fins de sortie longue à allure marathon.",
  specific: "On s'habitue à l'allure et à la durée de la course, avec les sorties longues les plus importantes du plan.",
  taper: "On baisse le volume pour arriver frais, en gardant quelques rappels d'allure sans fatigue.",
  race: "Quelques footings courts, du repos, et le grand jour.",
};

/** Tailwind classes per phase: the colour band, and a soft chip. */
export const PHASE_STYLE: Record<RacePhase, { band: string; chip: string }> = {
  recovery: { band: "bg-gray-400", chip: "bg-gray-100 text-gray-700" },
  base: { band: "bg-sky-500", chip: "bg-sky-50 text-sky-800" },
  development: { band: "bg-indigo-500", chip: "bg-indigo-50 text-indigo-800" },
  specific: { band: "bg-orange-500", chip: "bg-orange-50 text-orange-800" },
  taper: { band: "bg-emerald-500", chip: "bg-emerald-50 text-emerald-800" },
  race: { band: "bg-red-500", chip: "bg-red-50 text-red-800" },
};

export const KEY_SESSION_LABEL_FR: Record<RaceKeySession, string> = {
  none: "Footings faciles",
  threshold: "Séance au seuil",
  vo2max: "Fractionné court",
  mp_tempo: "Tempo à allure marathon",
  race_pace: "Tempo à allure semi",
  mp_reminder: "Rappels d'allure",
  race: "Course",
  time_trial: "Test chronométré",
  long_tempo: "Long tempo",
  strides: "Sortie longue = seule séance dure",
};

/** "1 h 50" / "45 min" — a duration in minutes. */
export function fmtDuration(minutes: number): string {
  if (minutes <= 0) return "—";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")}`;
}
