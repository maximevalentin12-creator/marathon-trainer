import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { parseGarminCsv, syntheticActivityId } from "@/lib/garmin/parseCsv";
import { matchGarminActivitiesForUser, reevaluateCompletedSessionsForUser } from "@/lib/garmin/matchSessions";
import { raiseHrMaxFromObserved } from "@/lib/athlete/profile";

type ActivityRow = { garmin_activity_id: number; user_id: string; start_time: string } & Record<string, unknown>;

/** Native Garmin ids (scripts/sync_garmin.py) are below this; CSV synthetic ids are 51-bit hashes above it. */
const NATIVE_ID_MAX = 1e12;

/** Identity/bookkeeping columns an import never rewrites on an existing row. */
const IDENTITY_COLUMNS = new Set(["id", "garmin_activity_id", "user_id", "start_time", "created_at"]);

/**
 * Epoch ms for a start_time, whether it's the CSV's naive "YYYY-MM-DD HH:MM:SS"
 * (stored as UTC, like scripts/sync_garmin.py's startTimeLocal) or a
 * timestamptz string read back from the DB.
 */
function startTimeMs(s: string | null | undefined): number | null {
  if (!s) return null;
  const iso = s.trim().replace(" ", "T");
  const hasZone = /T.*(Z|[+-]\d{2}(:?\d{2})?)$/.test(iso);
  const t = Date.parse(hasZone ? iso : iso + "Z");
  return isNaN(t) ? null : t;
}

/**
 * Columns to write onto an existing activity from a CSV row. A native
 * Garmin row is authoritative: the CSV only fills its missing (null) columns.
 * An earlier CSV import is refreshed with every non-null CSV value. Unchanged
 * values are left out, so re-importing the same file writes nothing.
 */
function activityPatch(existing: Record<string, unknown>, row: ActivityRow): Record<string, unknown> {
  const existingIsNative = Number(existing.garmin_activity_id) < NATIVE_ID_MAX;
  const patch: Record<string, unknown> = {};
  for (const [col, value] of Object.entries(row)) {
    if (IDENTITY_COLUMNS.has(col) || value === null || value === undefined) continue;
    const current = existing[col];
    if (existingIsNative && current !== null && current !== undefined) continue;
    if (JSON.stringify(current) === JSON.stringify(value)) continue;
    patch[col] = value;
  }
  return patch;
}

/**
 * POST /api/import/csv
 * multipart/form-data: `file` (Garmin Connect "Export CSV") + `userId`.
 * Temporary replacement for the Garmin auto-sync while garminconnect is
 * blocked by Garmin's anti-bot system — see scripts/sync_garmin.py.
 * An activity whose start_time already exists for the user updates that row
 * (see activityPatch) instead of inserting a duplicate.
 */
export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("file");
  const userId = form.get("userId");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing required file field: file" }, { status: 400 });
  }
  if (typeof userId !== "string" || !userId) {
    return NextResponse.json({ error: "Missing required field: userId" }, { status: 400 });
  }

  const text = await file.text();

  let parsed;
  try {
    parsed = parseGarminCsv(text);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }

  const rows: ActivityRow[] = parsed.activities.map((a) => ({
    garmin_activity_id: syntheticActivityId(a.startTime, String(a.distanceMeters)),
    user_id: userId,
    activity_type: a.activityType,
    start_time: a.startTime,
    duration_seconds: a.durationSeconds,
    distance_meters: a.distanceMeters,
    avg_pace_sec_per_km: a.avgPaceSecPerKm,
    avg_heart_rate: a.avgHeartRate,
    max_heart_rate: a.maxHeartRate,
    avg_cadence: a.avgCadence,
    max_cadence: a.maxCadence,
    avg_ground_contact_ms: a.avgGroundContactMs,
    avg_vertical_oscillation: a.avgVerticalOscillation,
    avg_stride_length: a.avgStrideLength,
    aerobic_te: a.aerobicTe,
    best_pace_sec_per_km: a.bestPaceSecPerKm,
    total_ascent_m: a.totalAscentM,
    gap_pace_sec_per_km: a.gapPaceSecPerKm,
    raw_data: a.raw,
  }));

  let inserted = 0;
  let updated = 0;
  let errors = 0;

  if (rows.length > 0) {
    const db = createServiceClient();

    // An activity whose start_time already exists for this user is the same
    // activity (typically the native Garmin-synced copy, or an earlier CSV
    // import) — update it, never insert a second row. Enforced in the DB by
    // garmin_activities_user_start_time_key (supabase/schema.sql).
    const rowsByStart = new Map<number, ActivityRow>();
    const unkeyedRows: ActivityRow[] = [];
    for (const row of rows) {
      const t = startTimeMs(row.start_time);
      if (t === null) unkeyedRows.push(row);
      else if (!rowsByStart.has(t)) rowsByStart.set(t, row);
    }

    const existingByStart = new Map<number, Record<string, unknown>>();
    if (rowsByStart.size > 0) {
      const times = Array.from(rowsByStart.keys());
      const DAY_MS = 24 * 3600 * 1000;
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await db
          .from("garmin_activities")
          .select("*")
          .eq("user_id", userId)
          .gte("start_time", new Date(Math.min(...times) - DAY_MS).toISOString())
          .lte("start_time", new Date(Math.max(...times) + DAY_MS).toISOString())
          .order("start_time", { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        for (const a of data ?? []) {
          const t = startTimeMs(a.start_time as string);
          if (t !== null && !existingByStart.has(t)) existingByStart.set(t, a);
        }
        if (!data || data.length < PAGE) break;
      }
    }

    const toInsert: ActivityRow[] = [...unkeyedRows];
    for (const [t, row] of Array.from(rowsByStart.entries())) {
      const existing = existingByStart.get(t);
      if (!existing) {
        toInsert.push(row);
        continue;
      }
      const patch = activityPatch(existing, row);
      if (Object.keys(patch).length === 0) continue;
      const { error } = await db.from("garmin_activities").update(patch).eq("id", existing.id as string);
      if (error) errors++;
      else updated++;
    }

    if (toInsert.length > 0) {
      const { data, error } = await db.from("garmin_activities").insert(toInsert).select("id");
      if (error) errors += toInsert.length;
      else inserted = data?.length ?? toInsert.length;
    }
  }

  let matched = 0;
  let reevaluated = 0;
  if (inserted + updated > 0) {
    try {
      // Before matching/re-scoring, so both use the raised zones.
      await raiseHrMaxFromObserved(createServiceClient(), userId);
    } catch (err) {
      console.warn(`Skipped observed hr_max update for user ${userId}:`, err);
    }
    try {
      matched = await matchGarminActivitiesForUser(userId);
    } catch (err) {
      console.warn(`Skipped session-completion matching for user ${userId}:`, err);
    }
    try {
      // Upserted rows may have refreshed an already-linked activity with richer
      // fields (or evaluateCompletion() itself may have gained fields since that
      // session was first matched) — re-score already-completed sessions too.
      reevaluated = await reevaluateCompletedSessionsForUser(userId);
    } catch (err) {
      console.warn(`Skipped re-evaluation of completed sessions for user ${userId}:`, err);
    }
  }

  return NextResponse.json({ inserted, updated, skipped: parsed.skipped, errors, matched, reevaluated });
}
