import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import { watchUserCalendar } from "@/lib/google/sync";

/**
 * POST /api/google/watch
 * Registers/renews the Google Calendar push-notification channel for the signed-in user.
 * Google channels expire (max ~7 days for calendar events), so this must be called periodically — by a
 * signed-in client; a scheduled job would need its own credentials (none is wired up).
 */
export async function POST() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  try {
    const watch = await watchUserCalendar(auth.db, auth.userId);
    return NextResponse.json({ ok: true, ...watch });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to register Google Calendar watch." },
      { status: 500 }
    );
  }
}
