// Prints the backward race plan for a user from their REAL data (races + Garmin history).
//   npx tsx scripts/print-race-plan.ts <userId>
// Reads .env.local for the Supabase credentials; read-only.

import "./load-env";
import { createServiceClient } from "../lib/supabase";
import { loadRaces } from "../lib/races";
import { loadAthleteCalibration } from "../lib/athlete/profile";
import { addDays, isoDate, parseIsoDate, toMonday } from "../lib/planner/dates";
import { isRaceActivity, resolveRacePlanWeek } from "../lib/planner/racePlanWeek";
import { RACE_PAIN_WARNING_MIN_SCORE } from "../lib/planner/race";

async function main() {
  const userId = process.argv[2];
  if (!userId) throw new Error("usage: tsx scripts/print-race-plan.ts <userId>");
  const db = createServiceClient();
  const today = parseIsoDate(isoDate(new Date()));

  const races = await loadRaces(db, userId);
  const since = addDays(today, -120).toISOString();
  const { data: rows, error } = await db
    .from("garmin_activities")
    .select("start_time, duration_seconds, distance_meters, activity_type, event_type:raw_data->eventType->>typeKey")
    .eq("user_id", userId)
    .gte("start_time", since);
  if (error) throw new Error(error.message);
  const { data: flags } = await db
    .from("subjective_entries")
    .select("entry_date")
    .eq("user_id", userId)
    .gte("pain_score", RACE_PAIN_WARNING_MIN_SCORE)
    .gte("entry_date", isoDate(addDays(today, -42)));
  const { calibration } = await loadAthleteCalibration(db, userId);

  const activities = (rows ?? []).map((a) => {
    const startTime = new Date(a.start_time);
    const distanceKm = (a.distance_meters ?? 0) / 1000;
    return {
      startTime,
      distanceKm,
      durationMinutes: (a.duration_seconds ?? 0) / 60,
      activityType: a.activity_type,
      isRace: isRaceActivity({ startTime, distanceKm, eventType: (a as { event_type?: string | null }).event_type }, races),
    };
  });

  const resolved = resolveRacePlanWeek({
    races,
    weekStart: toMonday(today),
    today,
    activities,
    flaggedDates: (flags ?? []).map((f) => parseIsoDate(f.entry_date)),
    easyPaceSecPerKm: calibration.easyPaceSecPerKm,
  });
  if (!resolved) throw new Error("No upcoming goal race found for this user.");
  const { plan } = resolved;
  const easy = calibration.easyPaceSecPerKm;
  const names = new Map(races.map((r) => [r.id, r.name]));

  console.log(`Baseline: ${plan.baselineKm} km/week (median of the last 4 full weeks)`);
  console.log(`Long-run anchor: ${plan.longRunAnchorMin} min (longest non-race run of the last 12 weeks)`);
  console.log(`Easy pace: ${Math.floor(easy / 60)}:${String(Math.round(easy % 60)).padStart(2, "0")}/km — peak week: ${plan.peakKm} km`);
  if (plan.warnings.length) console.log("Warnings:\n - " + plan.warnings.join("\n - "));
  console.log("\nwk  dates          n  phase        km  long  long%  MP km  key           races");
  const md = (d: Date) => isoDate(d).slice(5);
  plan.weeks.forEach((w, i) => {
    const pct = w.longRunMin > 0 && w.targetKm > 0 ? Math.round(((w.longRunMin * 60) / easy / w.targetKm) * 100) + "%" : "-";
    const tags = [
      w.raceIds.map((id) => names.get(id) ?? id).join(", "),
      w.isDeload ? "deload" : "",
    ].filter(Boolean);
    console.log(
      `${String(i).padStart(2)}  ${md(w.weekStart)}..${md(addDays(w.weekStart, 6))} ${String(w.weeksToRace).padStart(2)}  ` +
        `${w.phase.padEnd(12)} ${String(w.targetKm).padStart(3)} ${String(w.longRunMin).padStart(5)} ${pct.padStart(6)}  ${String(w.longRunMpBlock ? w.longRunMpBlock.reps * w.longRunMpBlock.kmEach : "-").padStart(5)}  ` +
        `${w.keySession.padEnd(13)} ${tags.join(" · ")}`
    );
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
