import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { requireUser } from "@/lib/auth/server";
import { buildAuthUrl, GOOGLE_STATE_COOKIE } from "@/lib/google/client";

/**
 * GET /api/google/auth
 * Redirects the signed-in user to Google's OAuth consent screen. `state` is a one-time random value, kept in an
 * httpOnly cookie and checked by /api/google/callback — no user id travels through Google.
 */
export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  try {
    const state = randomBytes(24).toString("hex");
    const response = NextResponse.redirect(buildAuthUrl(state));
    response.cookies.set(GOOGLE_STATE_COOKIE, state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/google",
      maxAge: 600,
    });
    return response;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to build Google auth URL." },
      { status: 500 }
    );
  }
}
