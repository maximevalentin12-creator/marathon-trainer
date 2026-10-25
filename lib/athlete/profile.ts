// The athlete's physiological profile (users.hr_max / hr_rest, each with its
// source) and everything derived from it: HR zones, pace reference, easy
// pace. Server-only DB orchestration — the pure derivations live in
// lib/planner/zones.ts and lib/planner/easyPace.ts.
//
// Source precedence for hr_max / hr_rest:
// - field_test (set in /profil) wins over garmin_settings: a Garmin-settings
//   value must never overwrite it.
// - observed only ever RAISES hr_max (raiseHrMaxFromObserved): a recorded HR
//   above the current max proves the max is higher; a lower one proves nothing.

import type { Db } from "@/lib/supabase";
import {
  DEFAULT_HR_MAX,
  DEFAULT_HR_REST,
  heartRateZones,
  paceReferenceSecPerKm,
  type HeartRateZones,
} from "@/lib/planner/zones";
import { EASY_PACE_WINDOW_DAYS, estimateEasyPace, type EasyPaceEstimate } from "@/lib/planner/easyPace";
import type { AthleteCalibration, SessionKind } from "@/lib/planner/types";

type ServiceClient = Db;

export const HR_SOURCES = ["garmin_settings", "field_test", "observed"] as const;
export type HrSource = (typeof HR_SOURCES)[number];

export function isHrSource(value: unknown): value is HrSource {
  return typeof value === "string" && (HR_SOURCES as readonly string[]).includes(value);
}

export const HR_SOURCE_LABEL_FR: Record<HrSource, string> = {
  garmin_settings: "Réglages Garmin",
  field_test: "Test terrain",
  observed: "Observée en séance",
};

/** Accepted range for a manually entered value — anything outside is a typo. */
export const HR_MAX_RANGE = { min: 140, max: 230 } as const;
export const HR_REST_RANGE = { min: 30, max: 100 } as const;

/**
 * An activity max HR above this is a sensor artifact (optical HR locking onto
 * cadence, strap static), not physiology — never let one raise hr_max, since
 * observed data can't lower it back.
 */
const MAX_PLAUSIBLE_OBSERVED_HR = HR_MAX_RANGE.max;

/** Postgres "undefined_column": the profile migration (supabase/schema.sql) hasn't been applied yet. */
const UNDEFINED_COLUMN = "42703";

export interface AthleteProfile {
  hrMax: number;
  hrMaxSource: HrSource;
  hrMaxUpdatedAt: string | null;
  hrRest: number;
  hrRestSource: HrSource;
  pb10kSeconds: number | null;
  /** False when the profile columns don't exist yet and these are the defaults. */
  stored: boolean;
}

export async function loadAthleteProfile(db: ServiceClient, userId: string): Promise<AthleteProfile> {
  const { data, error } = await db
    .from("users")
    .select("pb_10k_seconds, hr_max, hr_max_source, hr_max_updated_at, hr_rest, hr_rest_source")
    .eq("id", userId)
    .maybeSingle();

  if (error && error.code === UNDEFINED_COLUMN) {
    console.warn("users.hr_max/hr_rest missing — apply the athlete-profile migration in supabase/schema.sql.");
    const { data: user } = await db.from("users").select("pb_10k_seconds").eq("id", userId).maybeSingle();
    return {
      hrMax: DEFAULT_HR_MAX,
      hrMaxSource: "garmin_settings",
      hrMaxUpdatedAt: null,
      hrRest: DEFAULT_HR_REST,
      hrRestSource: "garmin_settings",
      pb10kSeconds: user?.pb_10k_seconds ?? null,
      stored: false,
    };
  }
  if (error) throw new Error(error.message);

  return {
    hrMax: data?.hr_max ?? DEFAULT_HR_MAX,
    hrMaxSource: isHrSource(data?.hr_max_source) ? data.hr_max_source : "garmin_settings",
    hrMaxUpdatedAt: data?.hr_max_updated_at ?? null,
    hrRest: data?.hr_rest ?? DEFAULT_HR_REST,
    hrRestSource: isHrSource(data?.hr_rest_source) ? data.hr_rest_source : "garmin_settings",
    pb10kSeconds: data?.pb_10k_seconds ?? null,
    stored: Boolean(data),
  };
}

export function profileZones(profile: AthleteProfile): HeartRateZones {
  return heartRateZones(profile.hrMax, profile.hrRest);
}

export async function loadAthleteZones(db: ServiceClient, userId: string): Promise<HeartRateZones> {
  return profileZones(await loadAthleteProfile(db, userId));
}

/**
 * Raises hr_max to the highest max_heart_rate recorded in the user's
 * activities when that's above it (source: observed). Never lowers it. After
 * a field test, only activities recorded since the test count: the athlete
 * re-measured on purpose, so older readings (likely artifacts) shouldn't undo it.
 */
export async function raiseHrMaxFromObserved(
  db: ServiceClient,
  userId: string
): Promise<{ raised: boolean; hrMax: number; previous: number }> {
  const profile = await loadAthleteProfile(db, userId);
  const unchanged = { raised: false, hrMax: profile.hrMax, previous: profile.hrMax };
  if (!profile.stored) return unchanged;

  let query = db
    .from("garmin_activities")
    .select("max_heart_rate")
    .eq("user_id", userId)
    .gt("max_heart_rate", profile.hrMax)
    .lte("max_heart_rate", MAX_PLAUSIBLE_OBSERVED_HR)
    .order("max_heart_rate", { ascending: false })
    .limit(1);
  if (profile.hrMaxSource === "field_test" && profile.hrMaxUpdatedAt) {
    query = query.gt("start_time", profile.hrMaxUpdatedAt);
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const observed = data?.[0]?.max_heart_rate as number | undefined;
  if (observed == null || observed <= profile.hrMax) return unchanged;

  const { error: updateError } = await db
    .from("users")
    .update({ hr_max: observed, hr_max_source: "observed", hr_max_updated_at: new Date().toISOString() })
    .eq("id", userId)
    // Guard against a concurrent write having raised it further already.
    .lt("hr_max", observed);
  if (updateError) throw new Error(updateError.message);

  return { raised: true, hrMax: observed, previous: profile.hrMax };
}

/**
 * Easy-pace estimate from the user's own recent runs (see estimateEasyPace):
 * the last EASY_PACE_WINDOW_DAYS of activities, each tagged with the kind of
 * planned session it completed, if any.
 */
export async function estimateAthleteEasyPace(
  db: ServiceClient,
  userId: string,
  zones: HeartRateZones,
  paceRef: number
): Promise<EasyPaceEstimate> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - EASY_PACE_WINDOW_DAYS);

  const [{ data: activities, error: activitiesError }, { data: linked, error: linkedError }] = await Promise.all([
    db
      .from("garmin_activities")
      .select("garmin_activity_id, activity_type, duration_seconds, avg_heart_rate, avg_pace_sec_per_km, gap_pace_sec_per_km")
      .eq("user_id", userId)
      .gte("start_time", cutoff.toISOString()),
    db
      .from("planned_sessions")
      .select("garmin_activity_id, session_type")
      .eq("user_id", userId)
      .not("garmin_activity_id", "is", null),
  ]);
  if (activitiesError) throw new Error(activitiesError.message);
  if (linkedError) throw new Error(linkedError.message);

  const kindByActivity = new Map((linked ?? []).map((r) => [r.garmin_activity_id as number, r.session_type as SessionKind]));

  return estimateEasyPace(
    (activities ?? []).map((a) => ({
      activityType: a.activity_type,
      durationSeconds: a.duration_seconds,
      avgHeartRate: a.avg_heart_rate,
      avgPaceSecPerKm: a.avg_pace_sec_per_km,
      gapPaceSecPerKm: a.gap_pace_sec_per_km,
      plannedKind: kindByActivity.get(a.garmin_activity_id) ?? null,
    })),
    zones,
    paceRef
  );
}

export interface AthleteCalibrationResult {
  profile: AthleteProfile;
  calibration: AthleteCalibration;
  easyPace: EasyPaceEstimate;
}

/** Everything the planner needs about the athlete: zones, pace reference, easy pace. */
export async function loadAthleteCalibration(db: ServiceClient, userId: string): Promise<AthleteCalibrationResult> {
  const profile = await loadAthleteProfile(db, userId);
  const zones = profileZones(profile);
  const paceRef = paceReferenceSecPerKm(profile.pb10kSeconds);
  const easyPace = await estimateAthleteEasyPace(db, userId, zones, paceRef);
  return {
    profile,
    calibration: { zones, paceReferenceSecPerKm: paceRef, easyPaceSecPerKm: easyPace.secPerKm },
    easyPace,
  };
}
