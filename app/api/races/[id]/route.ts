import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import { RACE_RESPONSE_COLUMNS, validateRaceFields } from "@/lib/races";

/**
 * PATCH /api/races/:id
 * Body: { ...any subset of name/raceDate/distanceKm/kind/parentRaceId/bibStatus/targetTimeS/resultTimeS }
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { userId, db } = auth;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const fields = validateRaceFields(body, false);
  if ("error" in fields) return NextResponse.json({ error: fields.error }, { status: 400 });
  const { data, error } = await db
    .from("races")
    .update(fields.values)
    .eq("id", params.id)
    .eq("user_id", userId)
    .select(RACE_RESPONSE_COLUMNS)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Race not found." }, { status: 404 });
  return NextResponse.json({ race: data });
}

/**
 * DELETE /api/races/:id
 * Sessions already planned from it (the race session included) stay until
 * their week is regenerated.
 */
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { userId, db } = auth;
  const { error } = await db.from("races").delete().eq("id", params.id).eq("user_id", userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
