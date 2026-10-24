import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

/** POST { email } → find-or-create user row, return { userId, isNew } */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.toLowerCase().trim() : "";

  if (!email) {
    return NextResponse.json({ error: "email required" }, { status: 400 });
  }

  const db = createServiceClient();

  const { data: existing } = await db
    .from("users")
    .select("id")
    .eq("email", email)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ userId: existing.id, isNew: false });
  }

  const { data: created, error } = await db
    .from("users")
    .insert({ email })
    .select("id")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ userId: created.id, isNew: true });
}
