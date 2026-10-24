export interface RaceSummary {
  activityId: string;
  date: string; // ISO date (YYYY-MM-DD)
  distanceKm: number;
  durationMinutes: number;
  avgPaceSecPerKm: number | null;
  avgHeartRate: number | null;
  vo2maxEstimate: number | null;
  /** Aerobic/anaerobic classification — not automated in v1, see cahier des charges §5. */
  runType: string;
}

export interface MonthlySummary {
  userId: string;
  month: string; // YYYY-MM
  monthLabel: string; // e.g. "August 2026"
  totalKm: number;
  activityCount: number;
  /** Average Garmin VO2max estimate for the month, used as a VMA proxy. */
  vmaScore: number | null;
  /** Aerobic/anaerobic classification — not automated in v1, see cahier des charges §5. */
  runType: string;
  /** Placeholder heuristic (VMA + mileage trend vs previous month), not a validated metric. */
  improvementScore: number | null;
  improvementNote: string;
  /** Share of this month's planned_sessions marked completed. */
  consistencyScore: number | null;
  consistencyNote: string;
  /** Raw counts behind consistencyScore, for the dashboard's monthly counter and the PDF. */
  completedCount: number;
  skippedCount: number;
  totalPlannedCount: number;
  races: RaceSummary[];
  suggestions: string[];
}
