// Response shapes for GET /api/history — shared by the route and /historique.

import type { NonImpactMachine } from "@/lib/planner";

/**
 * - completed — planned session matched to a Garmin activity
 * - skipped   — user marked the planned session "Non réalisée"
 * - unmatched — planned session in the past, neither completed nor skipped
 *               (no Garmin activity was ever matched to it)
 * - off_plan  — Garmin activity not linked to any planned session ("hors plan")
 */
export type HistoryStatus = "completed" | "skipped" | "unmatched" | "off_plan";

/** "other" = a Garmin activity that's neither running nor a recognized non-impact modality (e.g. swimming). */
export type HistoryModality = "running" | "non_impact" | "other";

export interface HistoryRow {
  /** planned_sessions.id for planned rows, "garmin-<garmin_activity_id>" for off-plan rows. */
  id: string;
  /** YYYY-MM-DD — planned_date, or the activity's UTC start date for off-plan rows. */
  date: string;
  label: string;
  modality: HistoryModality;
  machine: NonImpactMachine | null;
  indoor: boolean;
  status: HistoryStatus;
  /** The race itself (session_type "race"): shown with its result, never a score. */
  isRace: boolean;
  planned: { durationMinutes: number | null; distanceKm: number | null } | null;
  actual: {
    durationMinutes: number | null;
    durationSeconds: number | null;
    distanceKm: number | null;
    avgPaceSecPerKm: number | null;
    avgHeartRate: number | null;
  } | null;
  completionScore: number | null;
  completionNote: string | null;
  completionAnalysis: string[] | null;
  shoe: { id: string; name: string } | null;
}

export interface HistoryWeek {
  /** Monday, YYYY-MM-DD. */
  weekStart: string;
  /**
   * Actual km of the week's completed *planned running* sessions — same
   * definition as the weekly mileage card's "actual" mode
   * (app/api/plan/weekly-mileage/route.ts), so the two never disagree.
   */
  runningKm: number;
  /** Actual km of the week's off-plan running activities, reported separately from runningKm. */
  offPlanRunningKm: number;
  /** Planned (non-rest) sessions shown for the week, running and non-impact. */
  plannedCount: number;
  completedCount: number;
  offPlanCount: number;
  /** Newest first. */
  rows: HistoryRow[];
}

export interface HistoryResponse {
  /** Newest first; weeks with no rows are omitted. */
  weeks: HistoryWeek[];
  /** Pass back as `before` to load the next (older) page; null once the history is exhausted. */
  nextBefore: string | null;
}
