import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { runIncrementalSync } from "@/lib/google/sync";

/**
 * POST /api/google/webhook
 * Google Calendar push-notification receiver. Google sends no event body —
 * just headers identifying the channel and the new resource state. We look
 * up which user the channel belongs to, verify the shared channel token,
 * and run an incremental sync to pull the actual change(s) from the API.
 *
 * https://developers.google.com/calendar/api/guides/push
 *
 * THE ONE OPEN ROUTE (see middleware.ts): Google sends no Supabase session, so it cannot be a signed-in request.
 * It authenticates the call itself — the channel id must exist in google_calendar_sync and the
 * X-Goog-Channel-Token header must equal that row's secret token — and it is the one place (besides the Garmin
 * sync script) that uses the service-role key, because there is no user session to run RLS against.
 */
export async function POST(req: NextRequest) {
  const channelId = req.headers.get("x-goog-channel-id");
  const channelToken = req.headers.get("x-goog-channel-token");
  const resourceState = req.headers.get("x-goog-resource-state");

  if (!channelId) {
    return NextResponse.json({ error: "Missing X-Goog-Channel-Id header." }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data: syncState, error } = await supabase
    .from("google_calendar_sync")
    .select("user_id, channel_token")
    .eq("channel_id", channelId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!syncState) {
    // Unknown/stale channel (e.g. already stopped) — ack so Google stops retrying.
    return NextResponse.json({ ok: true, ignored: "unknown channel" });
  }
  // A missing stored token must never match a missing header.
  if (!syncState.channel_token || syncState.channel_token !== channelToken) {
    return NextResponse.json({ error: "Channel token mismatch." }, { status: 403 });
  }

  // "sync" is Google's initial confirmation message when the channel is
  // created — no actual change happened, nothing to pull yet.
  if (resourceState === "sync") {
    return NextResponse.json({ ok: true, ignored: "sync confirmation" });
  }

  try {
    const result = await runIncrementalSync(supabase, syncState.user_id);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error(`Incremental sync failed for user ${syncState.user_id}:`, err);
    // 500 so Google retries the notification later.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Incremental sync failed." },
      { status: 500 }
    );
  }
}
