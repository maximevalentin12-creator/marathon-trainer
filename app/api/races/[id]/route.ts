import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { validateRaceFields } from "@/lib/races";

/**
 * PATCH /api/races/:id
 * Body: { userId, ...any subset of name/raceDate/distanceKm }
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { userId } = body as { userId?: string };
  if (!userId) return NextResponse.json({ error: "userId is required." }, { status: 400 });

  const fields = validateRaceFields(body, false);
  if ("error" in fields) return NextResponse.json({ error: fields.error }, { status: 400 });

  const db = createServiceClient();
  const { data, error } = await db
    .from("races")
    .update(fields.values)
    .eq("id", params.id)
    .eq("user_id", userId)
    .select("id, name, race_date, distance_km")
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Race not found." }, { status: 404 });
  return NextResponse.json({ race: data });
}

/**
 * DELETE /api/races/:id
 * Body: { userId }
 * Sessions already planned from it (the race session included) stay until
 * their week is regenerated.
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { userId } = body as { userId?: string };
  if (!userId) return NextResponse.json({ error: "userId is required." }, { status: 400 });

  const db = createServiceClient();
  const { error } = await db.from("races").delete().eq("id", params.id).eq("user_id", userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
