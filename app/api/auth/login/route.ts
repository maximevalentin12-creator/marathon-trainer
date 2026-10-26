import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/auth/server";

/**
 * POST /api/auth/login — body { email, password }.
 * Signs in on the server so the session cookies arrive as HTTP Set-Cookie headers (400-day lifetime). Cookies
 * written by script (document.cookie) are capped to 7 days by Safari's tracking prevention, which would sign the
 * home-screen app out every week; after this, the middleware keeps refreshing them the same way.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
  if (typeof body?.email !== "string" || typeof body?.password !== "string") {
    return NextResponse.json({ error: "E-mail et mot de passe requis." }, { status: 400 });
  }
  const { error } = await createSupabaseServerClient().auth.signInWithPassword({
    email: body.email.trim(),
    password: body.password,
  });
  if (error) return NextResponse.json({ error: "E-mail ou mot de passe incorrect." }, { status: 401 });
  return NextResponse.json({ ok: true });
}
