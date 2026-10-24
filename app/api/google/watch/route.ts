import { NextRequest, NextResponse } from "next/server";
import { watchUserCalendar } from "@/lib/google/sync";

/**
 * POST /api/google/watch
 * Body: { userId }
 * Registers/renews the Google Calendar push-notification channel for userId.
 * Google channels expire (max ~7 days for calendar events) — call this
 * periodically (e.g. a daily cron) to keep the webhook alive.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { userId } = body as { userId?: string };
  if (!userId) {
    return NextResponse.json({ error: "Required: userId." }, { status: 400 });
  }

  try {
    const watch = await watchUserCalendar(userId);
    return NextResponse.json({ ok: true, ...watch });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to register Google Calendar watch." },
      { status: 500 }
    );
  }
}
