import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";

/**
 * GET /api/shoes
 * Lists all shoes (active and retired) for a user, newest first.
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { userId, db } = auth;
  const { data, error } = await db
    .from("shoes")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ shoes: data ?? [] });
}

/**
 * POST /api/shoes
 * Body: { name, brand?, model?, dropMm?, stackHeelMm?, stackForefootMm?,
 *         weightG?, usageType?, imageUrl?, notes?, totalKm? }
 * Creates a new pair. totalKm defaults to 0 (only useful for seeding an
 * already-worn pair — new links via /api/plan/session accumulate from there).
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

  const {
    name,
    brand,
    model,
    dropMm,
    stackHeelMm,
    stackForefootMm,
    weightG,
    usageType,
    imageUrl,
    notes,
    totalKm,
  } = body as {
    name?: string;
    brand?: string | null;
    model?: string | null;
    dropMm?: number | null;
    stackHeelMm?: number | null;
    stackForefootMm?: number | null;
    weightG?: number | null;
    usageType?: string | null;
    imageUrl?: string | null;
    notes?: string | null;
    totalKm?: number | null;
  };
  if (!name || !name.trim()) return NextResponse.json({ error: "name is required." }, { status: 400 });
  const { data, error } = await db
    .from("shoes")
    .insert({
      user_id: userId,
      name: name.trim(),
      brand: brand ?? null,
      model: model ?? null,
      drop_mm: dropMm ?? null,
      stack_heel_mm: stackHeelMm ?? null,
      stack_forefoot_mm: stackForefootMm ?? null,
      weight_g: weightG ?? null,
      usage_type: usageType ?? null,
      image_url: imageUrl ?? null,
      notes: notes ?? null,
      total_km: totalKm ?? 0,
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ shoe: data });
}
