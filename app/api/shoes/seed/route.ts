import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";

const PLACEHOLDER_IMAGE = "/shoes/placeholder.svg";

/** Shoe photos are not versioned; fall back to a neutral placeholder when absent. */
function imageOrPlaceholder(url: string): string {
  return fs.existsSync(path.join(process.cwd(), "public", url)) ? url : PLACEHOLDER_IMAGE;
}

/**
 * The user's three real pairs, pre-filled from what's known today. The Kiprun
 * drop is intentionally left null — exact model (KD900 vs. KD Light range)
 * still needs confirming, noted in its `notes` field for the user to correct
 * from the /shoes edit view.
 */
const SEED_SHOES = [
  {
    name: "Hoka Clifton 9",
    brand: "Hoka",
    model: "Clifton 9",
    drop_mm: 5,
    stack_heel_mm: 32,
    stack_forefoot_mm: 27,
    weight_g: 248,
    usage_type: "daily/long run, outdoor",
    image_url: "/shoes/hoka-clifton-9.png",
    total_km: 530,
    notes:
      "Amorti CMEVA, mousse souple, rocker précoce. Chaussure de sorties longues et footings faciles. Semelle extérieure tendre — usure plus rapide que la moyenne.",
  },
  {
    name: "Kiprun Ultra Light",
    brand: "Kiprun (Decathlon)",
    model: null,
    drop_mm: null,
    stack_heel_mm: null,
    stack_forefoot_mm: null,
    weight_g: null,
    usage_type: "treadmill, indoor",
    image_url: "/shoes/kiprun-ultra-light.png",
    total_km: 98,
    notes: "Paire légère réservée au tapis de course. Modèle exact à confirmer (probablement KD900 ou gamme KD Light).",
  },
  {
    name: "Adidas Adizero Evo SL",
    brand: "Adidas",
    model: "Adizero Evo SL",
    drop_mm: 6,
    stack_heel_mm: 39,
    stack_forefoot_mm: 33,
    weight_g: 224,
    usage_type: "performance/tempo",
    image_url: "/shoes/adidas-evo-sl.png",
    total_km: 0,
    notes:
      "Mousse Lightstrike Pro pleine longueur, shank plastique au médio-pied, pas de plaque carbone. Polyvalente : tempo, seuil, et allures rapides. Mousse fragile aux débris — éviter les terrains caillouteux. Durée de vie estimée ~700 km.",
  },
];

/**
 * POST /api/shoes/seed
 * Body: {}
 * One-off: inserts the three starting pairs, but only when this user has no
 * shoes yet — safe to call repeatedly (e.g. an accidental double-click) without
 * duplicating rows.
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

  const { count, error: countError } = await db
    .from("shoes")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (countError) return NextResponse.json({ error: countError.message }, { status: 500 });
  if (count && count > 0) {
    return NextResponse.json({ error: "Tu as déjà des paires enregistrées." }, { status: 409 });
  }

  const { data, error } = await db
    .from("shoes")
    .insert(SEED_SHOES.map((s) => ({ ...s, image_url: imageOrPlaceholder(s.image_url), user_id: userId })))
    .select("*");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ shoes: data ?? [] });
}
