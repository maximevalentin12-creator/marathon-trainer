import { NextRequest, NextResponse } from "next/server";
import { buildAuthUrl } from "@/lib/google/client";

/**
 * GET /api/google/auth?userId=<uuid>
 * Redirects to Google's OAuth consent screen. On success Google redirects
 * back to GOOGLE_REDIRECT_URI (/api/google/callback) with a code + state.
 */
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId");
  if (!userId) {
    return NextResponse.json({ error: "Required query param: userId." }, { status: 400 });
  }

  try {
    return NextResponse.redirect(buildAuthUrl(userId));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to build Google auth URL." },
      { status: 500 }
    );
  }
}
