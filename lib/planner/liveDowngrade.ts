import type { Db } from "@/lib/supabase";
import { loadAthleteCalibration } from "@/lib/athlete/profile";
import { applyLiveDowngrade } from "./rules";
import { computeLongRunAnchorMinutes } from "./anchor";
import { addDays, isoDate, parseIsoDate } from "./dates";
import type { SessionKind, Modality, NonImpactMachine } from "./types";

/**
 * Checks planned_sessions within the next 48h of a fresh subjective entry
 * and applies the downgrade rules (spec §2) to any that need it. Best-effort:
 * failures here shouldn't block saving the entry itself.
 */
export async function downgradeUpcomingSessions(
  db: Db,
  userId: string,
  entryDate: string,
  painScore: number,
  energyScore: number,
  opts: {
    /** Last day (YYYY-MM-DD) to re-check; default 2 days after the entry. */
    through?: string;
    /** First day to re-check; default the entry date. */
    from?: string;
    /** Debrief-driven block on quality sessions (pain / gait), applied to every session in range. */
    qualityBlock?: string | null;
  } = {}
) {
  const from = opts.from ?? entryDate;
  const to = opts.through ?? isoDate(addDays(parseIsoDate(entryDate), 2));

  const { data: candidates } = await db
    .from("planned_sessions")
    .select("id, planned_date, session_type, indoor, modality, machine, target_duration_minutes")
    .eq("user_id", userId)
    .gte("planned_date", from)
    .lte("planned_date", to)
    .neq("session_type", "rest")
    .eq("completed", false);

  if (!candidates || candidates.length === 0) return;

  const { calibration } = await loadAthleteCalibration(db, userId);

  // Same easy duration the week was planned with: derived from the stored long run.
  const { data: state } = await db
    .from("progression_state")
    .select("long_run_minutes")
    .eq("user_id", userId)
    .maybeSingle();
  let longRunMinutes: number | null = state?.long_run_minutes ?? null;
  if (longRunMinutes == null) {
    // No week generated yet — fall back to the anchor, as the first generation would.
    const activityCutoff = new Date();
    activityCutoff.setUTCDate(activityCutoff.getUTCDate() - 84);
    const { data: activities } = await db
      .from("garmin_activities")
      .select("start_time, duration_seconds, activity_type")
      .eq("user_id", userId)
      .gte("start_time", activityCutoff.toISOString());
    longRunMinutes = computeLongRunAnchorMinutes(
      (activities ?? []).map((a) => ({
        startTime: new Date(a.start_time),
        durationSeconds: a.duration_seconds ?? 0,
        activityType: a.activity_type,
      }))
    );
  }
  const easyMinutes = Math.max(20, Math.round((longRunMinutes * 0.55) / 5) * 5);

  const signal = { entryDate: parseIsoDate(entryDate), painScore, energyScore };

  for (const row of candidates) {
    // The pain / energy rules look 48h ahead of the entry; the quality block is not time-limited.
    const plannedDate = parseIsoDate(row.planned_date);
    const withinWindow = plannedDate.getTime() - signal.entryDate.getTime() <= 2 * 86_400_000;
    const updated = applyLiveDowngrade({
      userId,
      plannedDate,
      kind: row.session_type as SessionKind,
      modality: (row.modality ?? "running") as Modality,
      machine: (row.machine ?? null) as NonImpactMachine | null,
      indoor: row.indoor ?? false,
      currentDurationMinutes: row.target_duration_minutes ?? 0,
      easyMinutes,
      calibration,
      signal: withinWindow ? signal : null,
      qualityBlock: opts.qualityBlock ?? null,
    });
    if (!updated) continue;

    await db
      .from("planned_sessions")
      .update({
        session_type: updated.kind,
        session_label: updated.label,
        variant: updated.variant,
        modality: updated.modality,
        incline_percent: updated.inclinePercent,
        machine: updated.machine,
        steps: updated.steps,
        zone_summary: updated.zoneSummary,
        downgraded_from: updated.downgradedFrom,
        downgrade_reason: updated.downgradeReason,
        strides_added: updated.stridesAdded,
        target_distance_km: updated.targetDistanceKm,
        target_duration_minutes: updated.targetDurationMinutes,
        target_pace_sec_per_km: updated.targetPaceSecondsPerKm,
        why_note: updated.whyNote,
      })
      .eq("id", row.id);
  }
}
