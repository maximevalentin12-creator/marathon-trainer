import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

/** ISO Monday of the week containing dateStr (DATE string, no time). */
function weekMonday(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z"); // noon UTC avoids DST edge cases
  const day = d.getUTCDay(); // 0 = Sun
  const offset = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().split("T")[0];
}

function safeAvg(nums: number[]): number | null {
  if (!nums.length) return null;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
}

/**
 * GET /api/trends/subjective?userId=<uuid>&weeks=12
 * Returns per-week averages for pain, energy, and mood.
 */
export async function GET(req: NextRequest) {
  const params = new URL(req.url).searchParams;
  const userId = params.get("userId");
  const lookbackWeeks = Math.min(parseInt(params.get("weeks") ?? "12", 10), 52);

  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const db = createServiceClient();

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - lookbackWeeks * 7);

  const { data, error } = await db
    .from("subjective_entries")
    .select("entry_date, mood_score, energy_score, pain_score")
    .eq("user_id", userId)
    .gte("entry_date", cutoff.toISOString().split("T")[0])
    .order("entry_date", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const map: Record<string, { pains: number[]; energies: number[]; moods: number[] }> = {};

  for (const row of data ?? []) {
    const wk = weekMonday(row.entry_date);
    if (!map[wk]) map[wk] = { pains: [], energies: [], moods: [] };
    if (row.pain_score != null) map[wk].pains.push(row.pain_score);
    if (row.energy_score != null) map[wk].energies.push(row.energy_score);
    if (row.mood_score != null) map[wk].moods.push(row.mood_score);
  }

  const weeks = Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b)) // ascending — chart reads left→right
    .map(([week, { pains, energies, moods }]) => ({
      week,
      avgPain: safeAvg(pains),
      avgEnergy: safeAvg(energies),
      avgMood: safeAvg(moods),
      count: Math.max(pains.length, energies.length, moods.length),
    }));

  return NextResponse.json({ weeks });
}
