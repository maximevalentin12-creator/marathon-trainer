import type { InjurySide, InjuryZone, PainOnset } from "./types";

export const ZONE_LABEL_FR: Record<InjuryZone, string> = {
  foot: "Pied",
  ankle: "Cheville",
  shin: "Tibia",
  calf: "Mollet",
  knee: "Genou",
  thigh: "Cuisse",
  hip: "Hanche",
  back: "Dos",
  other: "Autre",
};

export const SIDE_LABEL_FR: Record<InjurySide, string> = {
  left: "Gauche",
  right: "Droite",
  both: "Les deux",
};

export const ONSET_LABEL_FR: Record<PainOnset, string> = {
  before: "Avant la sortie",
  during: "Pendant",
  after: "Après",
};

export const LEGS_LABEL_FR = ["Lourdes", "Fatiguées", "Normales", "Légères", "Très légères"];
export const ENERGY_LABEL_FR = ["À plat", "Basse", "Moyenne", "Bonne", "Excellente"];
export const ENJOYMENT_LABEL_FR = ["Corvée", "Bof", "Correct", "Plaisant", "Super"];

const FEMININE_ZONES: InjuryZone[] = ["ankle", "thigh", "hip"];

/** "Genou gauche", "Cuisse droite", "Dos" (a side means nothing for the back or "other"). */
export function zoneWithSideFr(zone: InjuryZone, side: InjurySide): string {
  if (zone === "back" || zone === "other") return ZONE_LABEL_FR[zone];
  if (side === "both") return `${ZONE_LABEL_FR[zone]} (les deux côtés)`;
  if (side === "left") return `${ZONE_LABEL_FR[zone]} gauche`;
  return `${ZONE_LABEL_FR[zone]} ${FEMININE_ZONES.includes(zone) ? "droite" : "droit"}`;
}
