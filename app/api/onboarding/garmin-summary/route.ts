import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";

/** Returns the ISO date of the Monday of the week containing `isoDatetime`. */
function weekMonday(isoDatetime: string): string {
  const d = new Date(isoDatetime);
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay(); // 0=Sun
  const offset = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().split("T")[0];
}

function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * GET /api/onboarding/garmin-summary
 * Returns per-week km, avg pace, avg VO2max for the last 12 weeks.
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { userId, db } = auth;

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 84); // 12 weeks back

  const { data, error } = await db
    .from("garmin_activities")
    .select("start_time, distance_meters, avg_pace_sec_per_km, vo2max_estimate")
    .eq("user_id", userId)
    .gte("start_time", cutoff.toISOString())
    .gt("distance_meters", 500)
    .order("start_time", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Aggregate by week
  const map: Record<string, { km: number; paces: number[]; vo2maxes: number[] }> = {};

  for (const row of data ?? []) {
    const wk = weekMonday(row.start_time);
    if (!map[wk]) map[wk] = { km: 0, paces: [], vo2maxes: [] };
    map[wk].km += (row.distance_meters ?? 0) / 1000;
    if (row.avg_pace_sec_per_km) map[wk].paces.push(row.avg_pace_sec_per_km);
    if (row.vo2max_estimate && row.vo2max_estimate > 0) map[wk].vo2maxes.push(row.vo2max_estimate);
  }

  const weeks = Object.entries(map)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([week, { km, paces, vo2maxes }]) => {
      const rawPace = avg(paces);
      const rawVo2 = avg(vo2maxes);
      return {
        week,
        km: Math.round(km * 10) / 10,
        avgPaceSec: rawPace !== null ? Math.round(rawPace) : null,
        avgVo2max: rawVo2 !== null ? Math.round(rawVo2 * 10) / 10 : null,
      };
    });

  // Recent average: last 4 weeks that had at least 1 km
  const last4 = weeks.slice(0, 4).filter((w) => w.km > 0);
  const recentAvgKm =
    last4.length > 0
      ? Math.round((last4.reduce((s, w) => s + w.km, 0) / last4.length) * 10) / 10
      : 0;

  return NextResponse.json({ weeks, recentAvgKm });
}
