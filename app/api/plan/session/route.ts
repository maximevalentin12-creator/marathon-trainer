import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import {
  toMonday,
  isoDate,
  parseIsoDate,
  dayCodeToOffset,
  isDayCode,
  addDays,
  type DayCode,
  type NonImpactMachine,
} from "@/lib/planner";
import { regenerateWeekSessions } from "@/lib/planner/generateWeek";
import { pushUserSessions } from "@/lib/google/sync";

const ALL_DAYS: DayCode[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/**
 * PATCH /api/plan/session
 * Body: { userId, sessionId, action: "move", dayCode }
 *     | { userId, sessionId, action: "reset" }
 *     | { userId, sessionId, action: "skip", skipped: boolean }
 *
 * "move" reassigns one session to a different day within the same week
 * (must be one of that week's available_days, and not already taken by
 * another session) and marks it as a manual override, so a later week
 * regeneration keeps it in place. "reset" clears that override and lets the
 * planner re-place the session automatically. "skip" marks a session as
 * manually not done (or clears that mark); a session can never be both
 * completed and skipped, so setting skipped=true also clears completed.
 * "setShoe" links a completed session to a shoe (or unlinks with shoeId:
 * null), moving the session's actual distance from the old pair's total_km
 * to the new one's.
 */
export async function PATCH(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { userId, sessionId, action } = body as { userId?: string; sessionId?: string; action?: string };
  if (!userId) return NextResponse.json({ error: "userId is required." }, { status: 400 });
  if (!sessionId) return NextResponse.json({ error: "sessionId is required." }, { status: 400 });
  if (action !== "move" && action !== "reset" && action !== "skip" && action !== "setShoe") {
    return NextResponse.json({ error: "action must be 'move', 'reset', 'skip', or 'setShoe'." }, { status: 400 });
  }

  const db = createServiceClient();

  const { data: session, error: sessionError } = await db
    .from("planned_sessions")
    .select("id, user_id, planned_date, session_type, completed, shoe_id, garmin_activity_id")
    .eq("id", sessionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (sessionError) return NextResponse.json({ error: sessionError.message }, { status: 500 });
  if (!session) return NextResponse.json({ error: "Session not found." }, { status: 404 });
  if (session.session_type === "rest" && action !== "skip" && action !== "setShoe") {
    return NextResponse.json({ error: "Un jour de repos ne peut pas être déplacé." }, { status: 400 });
  }

  if (action === "setShoe") {
    const { shoeId } = body as { shoeId?: unknown };
    if (shoeId !== null && typeof shoeId !== "string") {
      return NextResponse.json({ error: "shoeId must be a string or null." }, { status: 400 });
    }
    if (session.session_type === "rest") {
      return NextResponse.json({ error: "Un jour de repos n'a pas de paire de chaussures." }, { status: 400 });
    }
    if (!session.completed) {
      return NextResponse.json({ error: "Seule une séance complétée peut être liée à une paire." }, { status: 400 });
    }

    const oldShoeId = session.shoe_id as string | null;
    if (oldShoeId === shoeId) {
      const { data: unchanged, error: fetchError } = await db
        .from("planned_sessions")
        .select("*")
        .eq("id", sessionId)
        .single();
      if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
      return NextResponse.json({ ok: true, session: unchanged });
    }

    let distanceKm = 0;
    if (session.garmin_activity_id != null) {
      const { data: activity, error: activityError } = await db
        .from("garmin_activities")
        .select("distance_meters")
        .eq("garmin_activity_id", session.garmin_activity_id)
        .maybeSingle();
      if (activityError) return NextResponse.json({ error: activityError.message }, { status: 500 });
      if (activity?.distance_meters != null) {
        distanceKm = Math.round(activity.distance_meters / 100) / 10;
      }
    }

    if (shoeId !== null) {
      const { data: newShoe, error: newShoeError } = await db
        .from("shoes")
        .select("id, total_km")
        .eq("id", shoeId)
        .eq("user_id", userId)
        .maybeSingle();
      if (newShoeError) return NextResponse.json({ error: newShoeError.message }, { status: 500 });
      if (!newShoe) return NextResponse.json({ error: "Shoe not found." }, { status: 404 });

      const { error: creditError } = await db
        .from("shoes")
        .update({ total_km: newShoe.total_km + distanceKm })
        .eq("id", shoeId);
      if (creditError) return NextResponse.json({ error: creditError.message }, { status: 500 });
    }

    if (oldShoeId !== null) {
      const { data: oldShoe, error: oldShoeError } = await db
        .from("shoes")
        .select("id, total_km")
        .eq("id", oldShoeId)
        .maybeSingle();
      if (oldShoeError) return NextResponse.json({ error: oldShoeError.message }, { status: 500 });
      if (oldShoe) {
        const { error: debitError } = await db
          .from("shoes")
          .update({ total_km: Math.max(0, oldShoe.total_km - distanceKm) })
          .eq("id", oldShoeId);
        if (debitError) return NextResponse.json({ error: debitError.message }, { status: 500 });
      }
    }

    const { data: updated, error: updateError } = await db
      .from("planned_sessions")
      .update({ shoe_id: shoeId })
      .eq("id", sessionId)
      .select("*")
      .single();
    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    return NextResponse.json({ ok: true, session: updated });
  }

  if (action === "skip") {
    const { skipped } = body as { skipped?: unknown };
    if (typeof skipped !== "boolean") {
      return NextResponse.json({ error: "skipped must be a boolean." }, { status: 400 });
    }
    if (session.session_type === "rest") {
      return NextResponse.json({ error: "Un jour de repos ne peut pas être marqué non réalisé." }, { status: 400 });
    }

    const update: Record<string, unknown> = { skipped };
    if (skipped) {
      // Mutually exclusive with completed — clear any (possibly stale) Garmin match.
      update.completed = false;
      update.completed_at = null;
      update.garmin_activity_id = null;
      update.completion_score = null;
      update.completion_note = null;
      update.completion_analysis = null;
      update.indoor_mismatch = null;

      // Undoing a completed+shoe-linked session: refund its distance to the shoe.
      if (session.shoe_id != null) {
        let distanceKm = 0;
        if (session.garmin_activity_id != null) {
          const { data: activity } = await db
            .from("garmin_activities")
            .select("distance_meters")
            .eq("garmin_activity_id", session.garmin_activity_id)
            .maybeSingle();
          if (activity?.distance_meters != null) distanceKm = Math.round(activity.distance_meters / 100) / 10;
        }
        const { data: shoe } = await db.from("shoes").select("id, total_km").eq("id", session.shoe_id).maybeSingle();
        if (shoe) {
          await db
            .from("shoes")
            .update({ total_km: Math.max(0, shoe.total_km - distanceKm) })
            .eq("id", shoe.id);
        }
        update.shoe_id = null;
      }
    }

    const { data: updated, error: updateError } = await db
      .from("planned_sessions")
      .update(update)
      .eq("id", sessionId)
      .select("*")
      .single();
    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    return NextResponse.json({ ok: true, session: updated });
  }

  const weekStart = toMonday(parseIsoDate(session.planned_date));
  const weekStartIso = isoDate(weekStart);

  const { data: setup, error: setupError } = await db
    .from("weekly_setups")
    .select("runs_per_week, indoor_runs, non_impact_sessions, non_impact_machines, available_days")
    .eq("user_id", userId)
    .eq("week_start", weekStartIso)
    .maybeSingle();
  if (setupError) return NextResponse.json({ error: setupError.message }, { status: 500 });
  if (!setup) return NextResponse.json({ error: "No weekly setup found for this session's week." }, { status: 404 });

  const availableDayCodes = (setup.available_days ?? ALL_DAYS) as DayCode[];

  if (action === "move") {
    const { dayCode } = body as { dayCode?: unknown };
    if (!isDayCode(dayCode)) {
      return NextResponse.json({ error: "dayCode must be one of mon/tue/wed/thu/fri/sat/sun." }, { status: 400 });
    }
    if (!availableDayCodes.includes(dayCode)) {
      return NextResponse.json({ error: "dayCode is not one of this week's available days." }, { status: 400 });
    }

    const newPlannedDate = isoDate(addDays(weekStart, dayCodeToOffset(dayCode)));

    const { data: collision, error: collisionError } = await db
      .from("planned_sessions")
      .select("id")
      .eq("user_id", userId)
      .eq("planned_date", newPlannedDate)
      .neq("id", sessionId)
      .maybeSingle();
    if (collisionError) return NextResponse.json({ error: collisionError.message }, { status: 500 });
    if (collision) {
      return NextResponse.json({ error: "Ce jour est déjà occupé par une autre séance." }, { status: 409 });
    }

    const { data: updated, error: updateError } = await db
      .from("planned_sessions")
      .update({ planned_date: newPlannedDate, manual_day_override: true })
      .eq("id", sessionId)
      .select("*")
      .single();
    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    try {
      await pushUserSessions(userId);
    } catch (err) {
      console.warn(`Skipped Google Calendar push for user ${userId}:`, err instanceof Error ? err.message : err);
    }

    return NextResponse.json({ ok: true, session: updated });
  }

  // action === "reset"
  const { error: clearError } = await db
    .from("planned_sessions")
    .update({ manual_day_override: false })
    .eq("id", sessionId);
  if (clearError) return NextResponse.json({ error: clearError.message }, { status: 500 });

  const result = await regenerateWeekSessions({
    userId,
    weekStart,
    runsPerWeek: setup.runs_per_week,
    indoorRuns: setup.indoor_runs,
    nonImpactSessions: setup.non_impact_sessions ?? 0,
    nonImpactMachines: (setup.non_impact_machines ?? []) as NonImpactMachine[],
    availableDays: availableDayCodes.map(dayCodeToOffset),
  });
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });

  return NextResponse.json(result);
}
