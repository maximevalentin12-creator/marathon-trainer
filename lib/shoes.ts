// Shared wear-level thresholds for the shoe rotation feature ("L'armoire").
// General guidelines, not hard limits — actual lifespan varies by shoe model
// and runner weight, hence the disclaimer surfaced everywhere this is shown.

export type WearLevel = "green" | "amber" | "red";

export const WEAR_NOTE =
  "Repères généraux, pas des limites strictes — la durée de vie varie selon le modèle et le poids du coureur.";

export function wearLevel(totalKm: number): WearLevel {
  if (totalKm > 700) return "red";
  if (totalKm >= 500) return "amber";
  return "green";
}

export const WEAR_DOT_CLASS: Record<WearLevel, string> = {
  green: "bg-green-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
};

export const WEAR_TEXT_CLASS: Record<WearLevel, string> = {
  green: "text-green-700",
  amber: "text-amber-700",
  red: "text-red-700",
};
