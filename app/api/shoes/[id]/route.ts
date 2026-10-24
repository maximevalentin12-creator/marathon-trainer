import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

const EDITABLE_FIELDS: Record<string, string> = {
  name: "name",
  brand: "brand",
  model: "model",
  dropMm: "drop_mm",
  stackHeelMm: "stack_heel_mm",
  stackForefootMm: "stack_forefoot_mm",
  weightG: "weight_g",
  usageType: "usage_type",
  imageUrl: "image_url",
  notes: "notes",
  totalKm: "total_km",
  retired: "retired",
};

/**
 * PATCH /api/shoes/:id
 * Body: { userId, ...any subset of name/brand/model/dropMm/stackHeelMm/
 *         stackForefootMm/weightG/usageType/imageUrl/notes/totalKm/retired }
 * Partial update — only the fields present in the body are changed.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { userId } = body as { userId?: string };
  if (!userId) return NextResponse.json({ error: "userId is required." }, { status: 400 });

  const update: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(EDITABLE_FIELDS)) {
    if (key in body) update[column] = body[key];
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "No editable fields provided." }, { status: 400 });
  }
  if ("name" in update && (!update.name || typeof update.name !== "string" || !update.name.trim())) {
    return NextResponse.json({ error: "name cannot be empty." }, { status: 400 });
  }

  const db = createServiceClient();
  const { data, error } = await db
    .from("shoes")
    .update(update)
    .eq("id", id)
    .eq("user_id", userId)
    .select("*")
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Shoe not found." }, { status: 404 });
  return NextResponse.json({ shoe: data });
}

/**
 * DELETE /api/shoes/:id
 * Body: { userId }
 * Any planned_sessions linked to this shoe have shoe_id cleared automatically
 * (ON DELETE SET NULL) — their accumulated km stays on this row, which is
 * being deleted anyway.
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { userId } = body as { userId?: string };
  if (!userId) return NextResponse.json({ error: "userId is required." }, { status: 400 });

  const db = createServiceClient();
  const { error } = await db.from("shoes").delete().eq("id", id).eq("user_id", userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
