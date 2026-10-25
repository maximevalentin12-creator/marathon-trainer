import type { Db } from "@/lib/supabase";
import { generateClaudeSuggestions } from "./claudeSuggestions";
import type { MonthlySummary, RaceSummary } from "./types";

const RUN_TYPE_PLACEHOLDER =
  "Not yet classified — aerobic/anaerobic classification is deferred (cahier des charges §5).";

function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  const start = `${month}-01`;
  const end = new Date(Date.UTC(y, m, 1)).toISOString().split("T")[0]; // 1st of next month
  return { start, end };
}

function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

interface ActivityRow {
  garmin_activity_id: number;
  start_time: string;
  distance_meters: number | null;
  duration_seconds: number | null;
  avg_pace_sec_per_km: number | null;
  avg_heart_rate: number | null;
  vo2max_estimate: number | null;
  raw_data: Record<string, unknown> | null;
}

/**
 * Garmin tags some activities as races via eventType.typeKey === "race" when
 * the athlete marks it during recording. Best-effort heuristic — Garmin
 * doesn't guarantee every race gets tagged this way.
 */
function isRace(row: ActivityRow): boolean {
  const eventType = (row.raw_data as { eventType?: { typeKey?: string } } | null)?.eventType;
  return eventType?.typeKey === "race";
}

export async function buildMonthlySummary(db: Db, userId: string, month: string): Promise<MonthlySummary> {
  const { start, end } = monthRange(month);
  const prevMonth = previousMonth(month);
  const { start: prevStart, end: prevEnd } = monthRange(prevMonth);

  const [
    { data: activities, error: actError },
    { data: prevActivities, error: prevError },
    { data: sessions, error: sessionError },
  ] = await Promise.all([
    db
      .from("garmin_activities")
      .select(
        "garmin_activity_id, start_time, distance_meters, duration_seconds, avg_pace_sec_per_km, avg_heart_rate, vo2max_estimate, raw_data"
      )
      .eq("user_id", userId)
      .gte("start_time", start)
      .lt("start_time", end)
      .order("start_time", { ascending: true }),
    db
      .from("garmin_activities")
      .select("distance_meters, vo2max_estimate")
      .eq("user_id", userId)
      .gte("start_time", prevStart)
      .lt("start_time", prevEnd),
    db
      .from("planned_sessions")
      .select("completed, skipped")
      .eq("user_id", userId)
      .gte("planned_date", start)
      .lt("planned_date", end),
  ]);

  if (actError) throw new Error(actError.message);
  if (prevError) throw new Error(prevError.message);
  if (sessionError) throw new Error(sessionError.message);

  const rows = (activities ?? []) as ActivityRow[];

  const totalKm = Math.round(rows.reduce((s, r) => s + (r.distance_meters ?? 0), 0) / 100) / 10;

  const vo2Avg = avg(rows.map((r) => r.vo2max_estimate).filter((v): v is number => !!v && v > 0));
  const vmaScore = vo2Avg !== null ? Math.round(vo2Avg * 10) / 10 : null;

  const races: RaceSummary[] = rows.filter(isRace).map((r) => ({
    activityId: String(r.garmin_activity_id),
    date: r.start_time.slice(0, 10),
    distanceKm: Math.round(((r.distance_meters ?? 0) / 1000) * 100) / 100,
    durationMinutes: Math.round((r.duration_seconds ?? 0) / 60),
    avgPaceSecPerKm: r.avg_pace_sec_per_km,
    avgHeartRate: r.avg_heart_rate,
    vo2maxEstimate: r.vo2max_estimate,
    runType: RUN_TYPE_PLACEHOLDER,
  }));

  const prevRows = (prevActivities ?? []) as Array<{
    distance_meters: number | null;
    vo2max_estimate: number | null;
  }>;
  const prevTotalKm = prevRows.reduce((s, r) => s + (r.distance_meters ?? 0), 0) / 1000;
  const prevVmaAvg = avg(prevRows.map((r) => r.vo2max_estimate).filter((v): v is number => !!v && v > 0));

  // Improvement score is an unvalidated placeholder heuristic (VMA trend +
  // mileage trend vs the previous month) pending the methodology research
  // in cahier des charges §5 — not a scientific measure of "improvement".
  const deltas: number[] = [];
  const deltaParts: string[] = [];
  if (vmaScore !== null && prevVmaAvg !== null && prevVmaAvg > 0) {
    const pct = ((vmaScore - prevVmaAvg) / prevVmaAvg) * 100;
    deltas.push(pct);
    deltaParts.push(`VMA ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`);
  }
  if (prevTotalKm > 0) {
    const pct = ((totalKm - prevTotalKm) / prevTotalKm) * 100;
    deltas.push(pct);
    deltaParts.push(`mileage ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`);
  }
  const deltaAvg = avg(deltas);
  const improvementScore = deltaAvg !== null ? Math.round(deltaAvg * 10) / 10 : null;
  const improvementNote =
    deltaParts.length > 0
      ? `Vs. ${monthLabel(prevMonth)}: ${deltaParts.join(", ")}. Placeholder heuristic — pending methodology work (§5).`
      : `Not enough data — no logged activity in ${monthLabel(prevMonth)} to compare against.`;

  const sessionRows = (sessions ?? []) as Array<{ completed: boolean; skipped: boolean }>;
  const totalPlanned = sessionRows.length;
  const completedCount = sessionRows.filter((s) => s.completed).length;
  const skippedCount = sessionRows.filter((s) => s.skipped).length;
  const consistencyScore = totalPlanned > 0 ? Math.round((completedCount / totalPlanned) * 100) : null;
  const consistencyNote =
    totalPlanned > 0
      ? `${completedCount}/${totalPlanned} planned sessions completed this month.`
      : "No planned sessions found for this month.";

  const draft: Omit<MonthlySummary, "suggestions"> = {
    userId,
    month,
    monthLabel: monthLabel(month),
    totalKm,
    activityCount: rows.length,
    vmaScore,
    runType: RUN_TYPE_PLACEHOLDER,
    improvementScore,
    improvementNote,
    consistencyScore,
    consistencyNote,
    completedCount,
    skippedCount,
    totalPlannedCount: totalPlanned,
    races,
  };

  const suggestions = await generateClaudeSuggestions(draft);

  return { ...draft, suggestions };
}
