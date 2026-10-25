import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import {
  HR_MAX_RANGE,
  HR_REST_RANGE,
  loadAthleteCalibration,
  loadAthleteProfile,
} from "@/lib/athlete/profile";
import { reevaluateCompletedSessionsForUser } from "@/lib/garmin/matchSessions";
import { formulaEasyPaceSecPerKm, EASY_PACE_MIN_RUNS, EASY_PACE_WINDOW_DAYS } from "@/lib/planner";

/**
 * GET /api/profile
 * The athlete profile (FC max / FC repos with their sources), the zones
 * derived from it, and the easy-pace estimate with what it rests on.
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { userId, db } = auth;
  try {
    const { profile, calibration, easyPace } = await loadAthleteCalibration(db, userId);
    return NextResponse.json({
      profile,
      zones: calibration.zones,
      paceReferenceSecPerKm: calibration.paceReferenceSecPerKm,
      easyPace: {
        ...easyPace,
        formulaSecPerKm: formulaEasyPaceSecPerKm(calibration.paceReferenceSecPerKm),
        minRuns: EASY_PACE_MIN_RUNS,
        windowDays: EASY_PACE_WINDOW_DAYS,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

function inRange(v: unknown, range: { min: number; max: number }): v is number {
  return Number.isInteger(v) && (v as number) >= range.min && (v as number) <= range.max;
}

/**
 * PUT /api/profile
 * Body: { hrMax, hrRest }
 * A value changed here is a field measurement: it's stored with source
 * field_test (which wins over garmin_settings). Unchanged values keep their
 * source. Completed sessions are then re-scored against the new zones.
 */
export async function PUT(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { userId, db } = auth;
  const body = await req.json().catch(() => null);
  const { hrMax, hrRest } = (body ?? {}) as { hrMax?: unknown; hrRest?: unknown };
  if (!inRange(hrMax, HR_MAX_RANGE)) {
    return NextResponse.json(
      { error: `FC max invalide (entier entre ${HR_MAX_RANGE.min} et ${HR_MAX_RANGE.max}).` },
      { status: 400 }
    );
  }
  if (!inRange(hrRest, HR_REST_RANGE)) {
    return NextResponse.json(
      { error: `FC repos invalide (entier entre ${HR_REST_RANGE.min} et ${HR_REST_RANGE.max}).` },
      { status: 400 }
    );
  }
  if (hrMax - hrRest < 60) {
    return NextResponse.json({ error: "FC max et FC repos trop proches pour calculer des zones." }, { status: 400 });
  }
  const current = await loadAthleteProfile(db, userId);
  if (!current.stored) {
    return NextResponse.json(
      { error: "Profil non disponible — appliquer la migration « athlete profile » de supabase/schema.sql." },
      { status: 409 }
    );
  }

  const patch: Record<string, unknown> = {};
  if (hrMax !== current.hrMax) {
    patch.hr_max = hrMax;
    patch.hr_max_source = "field_test";
    patch.hr_max_updated_at = new Date().toISOString();
  }
  if (hrRest !== current.hrRest) {
    patch.hr_rest = hrRest;
    patch.hr_rest_source = "field_test";
  }

  let reevaluated = 0;
  if (Object.keys(patch).length > 0) {
    const { error } = await db.from("users").update(patch).eq("id", userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    try {
      reevaluated = await reevaluateCompletedSessionsForUser(db, userId);
    } catch (err) {
      console.warn(`Skipped re-evaluation after profile change for user ${userId}:`, err);
    }
  }

  return NextResponse.json({ ok: true, changed: Object.keys(patch).length > 0, reevaluated });
}
