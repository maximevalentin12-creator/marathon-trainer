import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import { loadRaceRows, racePainWarnings, RACE_RESPONSE_COLUMNS, validateRaceFields } from "@/lib/races";

/**
 * GET /api/races
 * Lists the user's races, soonest first, each with `pain_warning` (pain >= 3
 * reported in the 48 h before it).
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { userId, db } = auth;
  let races;
  try {
    races = await loadRaceRows(db, userId);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }

  // Pain >= 3 in the 48 h before a race: the race isn't downgraded, but the card warns.
  let warned: Set<string>;
  try {
    warned = await racePainWarnings(db, userId, races.map((r) => r.race_date as string));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
  return NextResponse.json({ races: races.map((r) => ({ ...r, pain_warning: warned.has(r.race_date as string) })) });
}

/**
 * POST /api/races
 * Body: { name, raceDate: "YYYY-MM-DD", distanceKm }
 * Creates a race. Week plans already generated aren't touched — regenerate a
 * week for race mode to reshape it.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { userId, db } = auth;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const fields = validateRaceFields(body, true);
  if ("error" in fields) return NextResponse.json({ error: fields.error }, { status: 400 });

  // A new race is in the future (a past one is only ever corrected, never created).
  if (fields.values.race_date && fields.values.race_date < new Date().toISOString().slice(0, 10)) {
    return NextResponse.json({ error: "La date de la course doit être dans le futur." }, { status: 400 });
  }
  const { data, error } = await db
    .from("races")
    .insert({ user_id: userId, ...fields.values })
    .select(RACE_RESPONSE_COLUMNS)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ race: data });
}
