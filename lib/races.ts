// The user's races (races table). Stored for the future race-based planner;
// for now only the temporary race mode reads them (lib/planner/race.ts).

import type { createServiceClient } from "@/lib/supabase";
import {
  addDays,
  isoDate,
  painReportedBeforeRace,
  parseIsoDate,
  RACE_PAIN_WARNING_MIN_SCORE,
  type Race,
  type SubjectiveSignal,
} from "@/lib/planner";

type ServiceClient = ReturnType<typeof createServiceClient>;

/** Postgres "undefined_table" / PostgREST "table not in schema cache" — the races migration hasn't run yet. */
const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205"]);

export interface RaceRow {
  id: string;
  name: string;
  race_date: string;
  distance_km: number;
}

export function raceFromRow(row: RaceRow): Race {
  return { id: row.id, name: row.name, raceDate: parseIsoDate(row.race_date), distanceKm: Number(row.distance_km) };
}

/** All the user's races, oldest first. Empty (with a warning) until the races migration is applied. */
export async function loadRaces(db: ServiceClient, userId: string): Promise<Race[]> {
  const { data, error } = await db
    .from("races")
    .select("id, name, race_date, distance_km")
    .eq("user_id", userId)
    .order("race_date", { ascending: true });
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
  const { data, error } = await db
    .from("subjective_entries")
    .select("entry_date, pain_score, energy_score")
    .eq("user_id", userId)
    .gte("pain_score", RACE_PAIN_WARNING_MIN_SCORE)
    .gte("entry_date", isoDate(addDays(parseIsoDate(sorted[0]), -2)))
    .lte("entry_date", sorted[sorted.length - 1]);
  if (error) throw new Error(error.message);
  const entries: SubjectiveSignal[] = (data ?? []).map((e) => ({
    entryDate: parseIsoDate(e.entry_date),
    painScore: e.pain_score ?? 0,
    energyScore: e.energy_score ?? 3,
  }));
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

type RaceColumns = { name?: string; race_date?: string; distance_km?: number };

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
    values.distance_km = Math.round(km * 100) / 100;
  }

  if (Object.keys(values).length === 0) return { error: "No editable fields provided." };
  return { values };
}
