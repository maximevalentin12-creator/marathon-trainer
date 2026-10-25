import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import type { Db } from "@/lib/supabase";
import { loadAthleteCalibration } from "@/lib/athlete/profile";
import {
  applyLiveDowngrade,
  computeLongRunAnchorMinutes,
  addDays,
  isoDate,
  parseIsoDate,
  type SessionKind,
  type Modality,
  type NonImpactMachine,
} from "@/lib/planner";

/**
 * Checks planned_sessions within the next 48h of a fresh subjective entry
 * and applies the downgrade rules (spec §2) to any that need it. Best-effort:
 * failures here shouldn't block saving the entry itself.
 */
async function downgradeUpcomingSessions(
  db: Db,
  userId: string,
  entryDate: string,
  painScore: number,
  energyScore: number
) {
  const from = entryDate;
  const to = isoDate(addDays(parseIsoDate(entryDate), 2));

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
    const updated = applyLiveDowngrade({
      userId,
      plannedDate: parseIsoDate(row.planned_date),
      kind: row.session_type as SessionKind,
      modality: (row.modality ?? "running") as Modality,
      machine: (row.machine ?? null) as NonImpactMachine | null,
      indoor: row.indoor ?? false,
      currentDurationMinutes: row.target_duration_minutes ?? 0,
      easyMinutes,
      calibration,
      signal,
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

/**
 * POST /api/log/save
 * Body: { entryDate, moodScore, energyScore, painScore,
 *         injuryNotes?, strainNotes?, overallNotes?, sessionId? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { userId, db } = auth;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body." }, { status: 400 });

  const {
    entryDate,
    moodScore,
    energyScore,
    painScore,
    injuryNotes,
    strainNotes,
    overallNotes,
    sessionId,
  } = body as {
    entryDate: string;
    moodScore: number;
    energyScore: number;
    painScore: number;
    injuryNotes?: string;
    strainNotes?: string;
    overallNotes?: string;
    sessionId?: string;
  };

  if (!entryDate) {
    return NextResponse.json({ error: "entryDate is required." }, { status: 400 });
  }

  if (
    !Number.isInteger(moodScore) || moodScore < 1 || moodScore > 5 ||
    !Number.isInteger(energyScore) || energyScore < 1 || energyScore > 5 ||
    !Number.isInteger(painScore) || painScore < 0 || painScore > 5
  ) {
    return NextResponse.json({ error: "Invalid score value." }, { status: 400 });
  }

  const { error } = await db.from("subjective_entries").insert({
    user_id: userId,
    entry_date: entryDate,
    mood_score: moodScore,
    energy_score: energyScore,
    pain_score: painScore,
    injury_notes: injuryNotes?.trim() || null,
    strain_notes: strainNotes?.trim() || null,
    overall_notes: overallNotes?.trim() || null,
    session_id: sessionId || null,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  try {
    await downgradeUpcomingSessions(db, userId, entryDate, painScore, energyScore);
  } catch (err) {
    console.warn(`Skipped upcoming-session downgrade check for user ${userId}:`, err instanceof Error ? err.message : err);
  }

  return NextResponse.json({ ok: true });
}
