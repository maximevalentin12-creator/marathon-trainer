export const INJURY_ZONES = ["foot", "ankle", "shin", "calf", "knee", "thigh", "hip", "back", "other"] as const;
export type InjuryZone = (typeof INJURY_ZONES)[number];

export type InjurySide = "left" | "right" | "both";
export type PainOnset = "before" | "during" | "after";

export interface PainReportInput {
  zone: InjuryZone;
  side: InjurySide;
  /** 0-10. */
  intensity: number;
  onset: PainOnset;
  affectsGait: boolean;
  notes?: string | null;
}

export interface DebriefInput {
  garminActivityId?: number | null;
  plannedSessionId?: string | null;
  /** YYYY-MM-DD. */
  date: string;
  /** 1-10. */
  effort: number;
  /** 1-5. */
  legs: number;
  /** 1-5. */
  energy: number;
  /** 1-5. */
  enjoyment: number;
  notes?: string | null;
  /** One entry per painful zone; empty/absent means no pain. */
  pain?: PainReportInput[];
}

export interface InjuryEpisode {
  id: string;
  zone: InjuryZone;
  side: InjurySide;
  /** YYYY-MM-DD. */
  startedOn: string;
  resolvedOn: string | null;
  peakIntensity: number;
  affectsGait: boolean;
}

/** A filled debrief as the cards show it. */
export interface DebriefView {
  id: string;
  effort: number;
  legs: number;
  energy: number;
  enjoyment: number;
  hasPain: boolean;
  /** Pain zones reported on this debrief, with the intensity (0-10). */
  pain: { zone: InjuryZone; side: InjurySide; intensity: number }[];
}

/** A synced activity still waiting for its debrief. */
export interface PendingDebrief {
  garminActivityId: number;
  plannedSessionId: string | null;
  /** YYYY-MM-DD. */
  date: string;
  label: string;
  durationMinutes: number | null;
  distanceKm: number | null;
}

export interface InjuryEpisodeHistory extends InjuryEpisode {
  notes: string | null;
  reports: { date: string; intensity: number; onset: PainOnset; affectsGait: boolean }[];
}

/** A debrief reduced to what the planner needs. */
export interface DebriefSummary {
  /** YYYY-MM-DD. */
  date: string;
  energy: number;
  hasPain: boolean;
  /** Highest report intensity (0-10) on this debrief; 0 when it has no report. */
  maxIntensity: number;
  affectsGait: boolean;
}
