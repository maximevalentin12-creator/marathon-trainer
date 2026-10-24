// Heart-rate zones and pace reference — the single source every consumer
// (session step hints, non-impact shifted zones, completion scoring, the zone
// legend, /profil) reads from. Zones are derived from the athlete's own
// FC max / FC repos (users.hr_max / hr_rest) with %HRR (Karvonen) bands;
// the defaults below are the spec's starting profile (§"Profil de départ").
// Pure and client-safe — DB loading lives in lib/athlete/profile.ts.

import type { EffortZone, EffortZoneId } from "./types";

export type HeartRateZones = Record<EffortZoneId, EffortZone>;

/** Spec's starting profile: FC max 208 / FC repos 67. */
export const DEFAULT_HR_MAX = 208;
export const DEFAULT_HR_REST = 67;

/** 5:02/km — spec's default 10K reference (50:24), used until a 10K PB is known. */
export const DEFAULT_PACE_REF_SEC_PER_KM = 302;

/** 10K reference pace in sec/km: the athlete's 10K PB when known, else the spec default. */
export function paceReferenceSecPerKm(pb10kSeconds: number | null | undefined): number {
  return pb10kSeconds ? pb10kSeconds / 10 : DEFAULT_PACE_REF_SEC_PER_KM;
}

/** %HRR band of each zone (fractions of FC max − FC repos, added to FC repos). */
const ZONE_BANDS: ReadonlyArray<{ id: EffortZoneId; label: string; lo: number; hi: number; feeling: string }> = [
  { id: "echauffement", label: "Échauffement", lo: 0.26, hi: 0.41, feeling: "Tu te mets en route, ça doit rester très facile" },
  { id: "facile", label: "Facile", lo: 0.41, hi: 0.56, feeling: "Tu pourrais tenir une conversation sans être essoufflé" },
  { id: "aerobie", label: "Aérobie", lo: 0.56, hi: 0.7, feeling: "Un peu plus soutenu, tu parlerais par phrases courtes" },
  {
    id: "seuil",
    label: "Seuil",
    lo: 0.7,
    hi: 0.85,
    feeling: "Dur mais maîtrisé — l'allure d'une course de 10 km, pas un sprint",
  },
  { id: "maximum", label: "Maximum", lo: 0.85, hi: 1, feeling: "Très dur, tu ne tiendrais ça que quelques minutes" },
];

/** Running HR zones for an athlete — 208/67 gives 104–125, 125–146, 146–166, 166–187, 187–208. */
export function heartRateZones(hrMax: number, hrRest: number): HeartRateZones {
  const reserve = hrMax - hrRest;
  const bpm = (fraction: number) => Math.round(hrRest + fraction * reserve);
  return Object.fromEntries(
    ZONE_BANDS.map((b) => [b.id, { id: b.id, label: b.label, bpmMin: bpm(b.lo), bpmMax: bpm(b.hi), feeling: b.feeling }])
  ) as HeartRateZones;
}

export function hrHint(zones: HeartRateZones, id: EffortZoneId): string {
  const z = zones[id];
  return `${z.bpmMin}–${z.bpmMax} bpm`;
}

/**
 * Heart rate runs roughly 15-20 bpm LOWER on a bike/assault bike than running
 * at equivalent perceived effort (no impact-related cardiac drift, different
 * muscle recruitment) — so non-impact sessions must not reuse the running HR
 * zones as-is. We shift every zone down by this much and drive the session
 * by perceived effort, with the shifted HR band as a loose check only.
 */
export const NON_IMPACT_HR_SHIFT_BPM = 18;

export function nonImpactHeartRateZones(zones: HeartRateZones): HeartRateZones {
  return Object.fromEntries(
    Object.entries(zones).map(([id, z]) => [
      id,
      { ...z, bpmMin: z.bpmMin - NON_IMPACT_HR_SHIFT_BPM, bpmMax: z.bpmMax - NON_IMPACT_HR_SHIFT_BPM },
    ])
  ) as HeartRateZones;
}

/** Same as hrHint(), but for non-impact sessions (pass the shifted zones) — always says so, since the shift is easy to miss. */
export function nonImpactHrHint(nonImpactZones: HeartRateZones, id: EffortZoneId): string {
  return `${hrHint(nonImpactZones, id)} (vélo/assault bike — FC ~15-20 bpm sous l'équivalent course)`;
}
