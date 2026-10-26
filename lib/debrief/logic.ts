// Pure debrief / injury-episode rules — no I/O, unit-tested in logic.test.ts.

import type { SubjectiveSignal } from "@/lib/planner/types";
import {
  INJURY_ZONES,
  type DebriefInput,
  type DebriefSummary,
  type InjuryEpisode,
  type InjurySide,
  type InjuryZone,
  type PainReportInput,
} from "./types";

/** An open episode with no new report for this many days is resolved. */
export const EPISODE_AUTO_RESOLVE_DAYS = 14;
/** Pain intensity (0-10) at which a debrief counts toward the quality-session block. */
export const BLOCKING_PAIN_INTENSITY = 4;

export const PROFESSIONAL_NOTE =
  "Douleur répétée ou qui modifie ta foulée : pas de séance qualité pour l'instant. Consulte un professionnel (médecin du sport, kiné) avant de reprendre l'intensité.";

const DAY_MS = 86_400_000;

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / DAY_MS);
}

/**
 * Maps a debrief onto the 0-5 pain scale the downgrade rules were written for
 * (intensity 0-10 halved, rounded up; flagged pain without a report counts as 1).
 */
export function legacyPainScore(d: DebriefSummary): number {
  if (!d.hasPain) return 0;
  return Math.max(1, Math.ceil(d.maxIntensity / 2));
}

export function debriefsToSignals(debriefs: DebriefSummary[]): SubjectiveSignal[] {
  return debriefs.map((d) => ({
    entryDate: new Date(d.date + "T00:00:00Z"),
    painScore: legacyPainScore(d),
    energyScore: d.energy,
  }));
}

/** The open episode for this zone + side, if any (at most one should exist). */
export function findOpenEpisode(episodes: InjuryEpisode[], zone: InjuryZone, side: InjurySide): InjuryEpisode | null {
  return episodes.find((e) => e.resolvedOn === null && e.zone === zone && e.side === side) ?? null;
}

/**
 * Open episodes whose latest report (or start) is more than EPISODE_AUTO_RESOLVE_DAYS before `today`.
 * They resolve on that last-activity date.
 */
export function staleEpisodes(
  episodes: InjuryEpisode[],
  lastReportOn: Map<string, string>,
  today: string
): { id: string; resolvedOn: string }[] {
  const out: { id: string; resolvedOn: string }[] = [];
  for (const e of episodes) {
    if (e.resolvedOn !== null) continue;
    const last = lastReportOn.get(e.id) ?? e.startedOn;
    if (dayDiff(today, last) > EPISODE_AUTO_RESOLVE_DAYS) out.push({ id: e.id, resolvedOn: last });
  }
  return out;
}

/**
 * Quality sessions are blocked (and a professional is suggested) when pain ≥ 4/10 shows on the two
 * most recent debriefs, or when an open episode — or the latest debrief — affects gait.
 * Returns the note to surface, or null.
 */
export function qualityBlockNote(debriefs: DebriefSummary[], openEpisodes: InjuryEpisode[]): string | null {
  const sorted = [...debriefs].sort((a, b) => b.date.localeCompare(a.date));
  const gait = openEpisodes.some((e) => e.resolvedOn === null && e.affectsGait) || !!sorted[0]?.affectsGait;
  const twoInARow =
    sorted.length >= 2 &&
    sorted[0].maxIntensity >= BLOCKING_PAIN_INTENSITY &&
    sorted[1].maxIntensity >= BLOCKING_PAIN_INTENSITY;
  return gait || twoInARow ? PROFESSIONAL_NOTE : null;
}

function intIn(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

/** Validates a request body into a DebriefInput; the second element is a French error message. */
export function parseDebriefInput(body: unknown): [DebriefInput, null] | [null, string] {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return [null, "Date invalide."];
  if (!intIn(b.effort, 1, 10)) return [null, "L'effort doit être entre 1 et 10."];
  if (!intIn(b.legs, 1, 5) || !intIn(b.energy, 1, 5) || !intIn(b.enjoyment, 1, 5)) {
    return [null, "Jambes, énergie et plaisir doivent être entre 1 et 5."];
  }
  const pain: PainReportInput[] = [];
  if (b.pain != null) {
    if (!Array.isArray(b.pain)) return [null, "Douleurs invalides."];
    for (const raw of b.pain as Record<string, unknown>[]) {
      if (
        typeof raw?.zone !== "string" || !(INJURY_ZONES as readonly string[]).includes(raw.zone) ||
        !["left", "right", "both"].includes(raw.side as string) ||
        !intIn(raw.intensity, 0, 10) ||
        !["before", "during", "after"].includes(raw.onset as string)
      ) {
        return [null, "Douleur invalide."];
      }
      pain.push({
        zone: raw.zone as InjuryZone,
        side: raw.side as InjurySide,
        intensity: raw.intensity,
        onset: raw.onset as PainReportInput["onset"],
        affectsGait: raw.affectsGait === true,
      });
    }
  }
  return [
    {
      garminActivityId: typeof b.garminActivityId === "number" ? b.garminActivityId : null,
      plannedSessionId: typeof b.plannedSessionId === "string" ? b.plannedSessionId : null,
      date: b.date,
      effort: b.effort,
      legs: b.legs,
      energy: b.energy,
      enjoyment: b.enjoyment,
      notes: typeof b.notes === "string" ? b.notes : null,
      pain,
    },
    null,
  ];
}
