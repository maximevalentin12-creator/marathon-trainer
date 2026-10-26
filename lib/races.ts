// The user's races (races table). Stored for the future race-based planner;
// for now only the temporary race mode reads them (lib/planner/race.ts).

import type { Db } from "@/lib/supabase";
import { loadDebriefSignals } from "@/lib/debrief";
import {
  addDays,
  isoDate,
  painReportedBeforeRace,
  parseIsoDate,
  RACE_PAIN_WARNING_MIN_SCORE,
  type Race,
  type SubjectiveSignal,
} from "@/lib/planner";

type ServiceClient = Db;

/** Postgres "undefined_table" / PostgREST "table not in schema cache" — the races migration hasn't run yet. */
const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205"]);

export interface RaceRow {
  id: string;
  name: string;
  race_date: string;
  distance_km: number;
  // Backward-planner columns — absent until that migration is applied.
  kind?: "goal" | "tune_up";
  parent_race_id?: string | null;
  bib_status?: "confirmed" | "pending" | "solo_test";
  target_time_s?: number | null;
  result_time_s?: number | null;
}

const RACE_COLUMNS = "id, name, race_date, distance_km";
const PLANNER_RACE_COLUMNS = `${RACE_COLUMNS}, kind, parent_race_id, bib_status, target_time_s, result_time_s`;
/** Postgres "undefined_column". */
const UNDEFINED_COLUMN = "42703";

export function raceFromRow(row: RaceRow): Race {
  return {
    id: row.id,
    name: row.name,
    raceDate: parseIsoDate(row.race_date),
    distanceKm: Number(row.distance_km),
    kind: row.kind ?? "goal",
    parentRaceId: row.parent_race_id ?? null,
    bibStatus: row.bib_status ?? "confirmed",
    targetTimeSeconds: row.target_time_s ?? null,
    resultTimeSeconds: row.result_time_s ?? null,
  };
}

/** The user's races as rows, oldest first, with the planner columns when the migration has run. */
export async function loadRaceRows(db: ServiceClient, userId: string): Promise<RaceRow[]> {
  const first = (await db
    .from("races")
    .select(PLANNER_RACE_COLUMNS)
    .eq("user_id", userId)
    .order("race_date", { ascending: true })) as { data: RaceRow[] | null; error: { code?: string; message: string } | null };
  if (first.error?.code !== UNDEFINED_COLUMN) {
    if (first.error) throw new Error(first.error.message);
    return first.data ?? [];
  }
  const { data, error } = await db
    .from("races")
    .select(RACE_COLUMNS)
    .eq("user_id", userId)
    .order("race_date", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as RaceRow[];
}

/** Columns a race endpoint returns. */
export const RACE_RESPONSE_COLUMNS = PLANNER_RACE_COLUMNS;

/** All the user's races, oldest first. Empty (with a warning) until the races migration is applied. */
export async function loadRaces(db: ServiceClient, userId: string): Promise<Race[]> {
  let { data, error } = (await db
    .from("races")
    .select(PLANNER_RACE_COLUMNS)
    .eq("user_id", userId)
    .order("race_date", { ascending: true })) as { data: RaceRow[] | null; error: { code?: string; message: string } | null };
  if (error?.code === UNDEFINED_COLUMN) {
    // The backward-planner migration hasn't run: the original columns still work (race mode only).
    ({ data, error } = (await db
      .from("races")
      .select(RACE_COLUMNS)
      .eq("user_id", userId)
      .order("race_date", { ascending: true })) as { data: RaceRow[] | null; error: { code?: string; message: string } | null });
  }
  if (error) {
    if (error.code && MISSING_TABLE_CODES.has(error.code)) {
      console.warn("races table missing — race mode off until the migration in supabase/schema.sql is applied.");
      return [];
    }
    throw new Error(error.message);
  }
  return ((data ?? []) as RaceRow[]).map(raceFromRow);
}

/**
 * For each race date (YYYY-MM-DD), whether pain was reported in the 48 h
 * before it (painReportedBeforeRace) — one query for all of them.
 */
export async function racePainWarnings(db: ServiceClient, userId: string, raceDates: string[]): Promise<Set<string>> {
  if (raceDates.length === 0) return new Set();
  const sorted = [...raceDates].sort();
  const entries: SubjectiveSignal[] = (
    await loadDebriefSignals(db, userId, isoDate(addDays(parseIsoDate(sorted[0]), -2)), sorted[sorted.length - 1])
  ).filter((s) => s.painScore >= RACE_PAIN_WARNING_MIN_SCORE);
  return new Set(raceDates.filter((d) => painReportedBeforeRace(entries, parseIsoDate(d))));
}

/** Adds `pain_warning` to planned_sessions rows: true on a race session with pain reported in the 48 h before it. */
export async function attachRacePainWarnings<T extends { session_type?: unknown; planned_date?: unknown }>(
  db: ServiceClient,
  userId: string,
  rows: T[]
): Promise<Array<T & { pain_warning: boolean }>> {
  const raceDates = rows.filter((r) => r.session_type === "race").map((r) => String(r.planned_date));
  const warned = await racePainWarnings(db, userId, raceDates);
  return rows.map((r) => ({
    ...r,
    pain_warning: r.session_type === "race" && warned.has(String(r.planned_date)),
  }));
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DISTANCE_KM = 400;

type RaceColumns = {
  name?: string;
  race_date?: string;
  distance_km?: number;
  kind?: "goal" | "tune_up";
  parent_race_id?: string | null;
  bib_status?: "confirmed" | "pending" | "solo_test";
  target_time_s?: number | null;
  result_time_s?: number | null;
};

const BIB_STATUSES = ["confirmed", "pending", "solo_test"] as const;

/**
 * Checks the name/raceDate/distanceKm fields of a race request body and maps
 * them to columns. `requireAll` for a create; an update takes any subset.
 */
export function validateRaceFields(
  body: Record<string, unknown>,
  requireAll: boolean
): { values: RaceColumns } | { error: string } {
  const values: RaceColumns = {};

  if ("name" in body || requireAll) {
    if (typeof body.name !== "string" || !body.name.trim()) return { error: "name is required." };
    values.name = body.name.trim();
  }
  if ("raceDate" in body || requireAll) {
    const d = body.raceDate;
    if (typeof d !== "string" || !ISO_DATE_RE.test(d) || Number.isNaN(new Date(d + "T00:00:00Z").getTime())) {
      return { error: "raceDate must be a YYYY-MM-DD date." };
    }
    values.race_date = d;
  }
  if ("distanceKm" in body || requireAll) {
    const km = body.distanceKm;
    if (typeof km !== "number" || !Number.isFinite(km) || km <= 0 || km > MAX_DISTANCE_KM) {
      return { error: `distanceKm must be a number between 0 and ${MAX_DISTANCE_KM}.` };
    }
    values.distance_km = Math.round(km * 1000) / 1000;
  }

  if ("kind" in body) {
    if (body.kind !== "goal" && body.kind !== "tune_up") return { error: "kind must be goal or tune_up." };
    values.kind = body.kind;
  }
  if ("parentRaceId" in body) {
    if (body.parentRaceId !== null && typeof body.parentRaceId !== "string") {
      return { error: "parentRaceId must be a race id or null." };
    }
    values.parent_race_id = body.parentRaceId;
  }
  if ("bibStatus" in body) {
    if (!(BIB_STATUSES as readonly unknown[]).includes(body.bibStatus)) {
      return { error: "bibStatus must be confirmed, pending or solo_test." };
    }
    values.bib_status = body.bibStatus as (typeof BIB_STATUSES)[number];
  }
  for (const [field, column] of [
    ["targetTimeS", "target_time_s"],
    ["resultTimeS", "result_time_s"],
  ] as const) {
    if (!(field in body)) continue;
    const t = body[field];
    if (t !== null && (typeof t !== "number" || !Number.isInteger(t) || t <= 0)) {
      return { error: `${field} must be a positive number of seconds or null.` };
    }
    values[column] = t as number | null;
  }

  if (Object.keys(values).length === 0) return { error: "No editable fields provided." };
  return { values };
}
