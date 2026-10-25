import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";

/** The Paris block: the goal marathon and the two tune-ups that lead to it. */
const GOAL = {
  name: "Marathon de Paris",
  race_date: "2027-04-04",
  distance_km: 42.195,
  kind: "goal",
  bib_status: "pending",
} as const;

const TUNE_UPS = [
  { name: "Semi de Paris", race_date: "2027-03-07", distance_km: 21.1, kind: "tune_up", bib_status: "pending" },
  { name: "10 km test", race_date: "2027-02-21", distance_km: 10, kind: "tune_up", bib_status: "solo_test" },
] as const;

/** A finished race whose result feeds the Riegel predictions (lib/planner/paces.ts). */
const PAST_RESULT = {
  name: "Semi d'Amsterdam",
  race_date: "2026-10-18",
  distance_km: 21.45,
  kind: "goal",
  bib_status: "confirmed",
  result_time_s: 1 * 3600 + 54 * 60 + 32,
} as const;

/**
 * POST /api/races/seed
 * Body: {}
 * One-off and idempotent: adds the Paris goal, its two tune-ups and the
 * Amsterdam half result, each only when no race with that name and date exists
 * for the user. Needs the backward-planner migration in supabase/schema.sql.
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

  const { data: existing, error: existingError } = await db
    .from("races")
    .select("id, name, race_date, result_time_s")
    .eq("user_id", userId);
  if (existingError) {
    // Only a missing table/column means the migration hasn't run — not, say, a network failure.
    const migrationMissing = ["42P01", "42703", "PGRST204", "PGRST205"].includes(existingError.code ?? "");
    return NextResponse.json(
      {
        error: migrationMissing
          ? `${existingError.message} — apply the backward-planner migration in supabase/schema.sql first.`
          : existingError.message,
      },
      { status: 500 }
    );
  }
  const find = (name: string, raceDate: string) =>
    (existing ?? []).find((r) => r.name === name && r.race_date === raceDate);

  const created: string[] = [];

  let goalId = find(GOAL.name, GOAL.race_date)?.id as string | undefined;
  if (!goalId) {
    const { data, error } = await db
      .from("races")
      .insert({ user_id: userId, ...GOAL })
      .select("id")
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    goalId = data.id as string;
    created.push(GOAL.name);
  }

  for (const t of TUNE_UPS) {
    const row = find(t.name, t.race_date);
    if (row) continue;
    const { error } = await db.from("races").insert({ user_id: userId, ...t, parent_race_id: goalId });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    created.push(t.name);
  }

  // The Amsterdam result: any race already on that date just gets the result filled in when it has none.
  const sameDay = (existing ?? []).find((r) => r.race_date === PAST_RESULT.race_date);
  if (!sameDay) {
    const { error } = await db.from("races").insert({ user_id: userId, ...PAST_RESULT });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    created.push(PAST_RESULT.name);
  } else if (sameDay.result_time_s == null) {
    const { error } = await db.from("races").update({ result_time_s: PAST_RESULT.result_time_s }).eq("id", sameDay.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    created.push(`${sameDay.name} (result)`);
  }

  return NextResponse.json({ created });
}
