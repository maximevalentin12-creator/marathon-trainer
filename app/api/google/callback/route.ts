import { NextRequest, NextResponse } from "next/server";
import { createOAuthClient } from "@/lib/google/client";
import { createServiceClient } from "@/lib/supabase";
import { watchUserCalendar } from "@/lib/google/sync";

/**
 * GET /api/google/callback
 * Handles Google's OAuth redirect: exchanges the code for tokens, stores
 * them, then registers a webhook watch channel so future edits made in
 * Google Calendar flow back into planned_sessions.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const userId = req.nextUrl.searchParams.get("state");
  const oauthError = req.nextUrl.searchParams.get("error");

  if (oauthError) {
    return NextResponse.json({ error: `Google OAuth error: ${oauthError}` }, { status: 400 });
  }
  if (!code || !userId) {
    return NextResponse.json({ error: "Missing code or state (userId) from Google redirect." }, { status: 400 });
  }

  try {
    const client = createOAuthClient();
    const { tokens } = await client.getToken(code);

    if (!tokens.refresh_token) {
      return NextResponse.json(
        {
          error:
            "Google did not return a refresh_token. Revoke prior access at https://myaccount.google.com/permissions and retry.",
        },
        { status: 400 }
      );
    }

    const supabase = createServiceClient();
    const { error } = await supabase.from("google_oauth_tokens").upsert({
      user_id: userId,
      access_token: tokens.access_token ?? "",
      refresh_token: tokens.refresh_token,
      scope: tokens.scope ?? null,
      token_type: tokens.token_type ?? null,
      expiry_date: tokens.expiry_date ?? null,
      updated_at: new Date().toISOString(),
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    let watch: Awaited<ReturnType<typeof watchUserCalendar>> | null = null;
    let watchError: string | null = null;
    try {
      watch = await watchUserCalendar(userId);
    } catch (err) {
      // Don't fail the whole connect flow if the webhook watch can't be set
      // up (e.g. APP_BASE_URL not public HTTPS yet in local dev) — the user
      // is still connected and push sync works; call /api/google/watch later.
      watchError = err instanceof Error ? err.message : "Failed to register webhook watch.";
      console.error(`Google Calendar watch setup failed for user ${userId}:`, err);
    }

    return NextResponse.json({ ok: true, connected: true, watch, watchError });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to complete Google OAuth flow." },
      { status: 500 }
    );
  }
}
