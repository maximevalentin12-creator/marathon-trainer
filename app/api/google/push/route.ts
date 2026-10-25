import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import { pushUserSessions } from "@/lib/google/sync";

/**
 * POST /api/google/push
 * Pushes the signed-in user's new/changed planned_sessions rows to Google Calendar.
 */
export async function POST() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  try {
    const result = await pushUserSessions(auth.db, auth.userId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to push sessions to Google Calendar." },
      { status: 500 }
    );
  }
}
