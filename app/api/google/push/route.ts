import { NextRequest, NextResponse } from "next/server";
import { pushUserSessions } from "@/lib/google/sync";

/**
 * POST /api/google/push
 * Body: { userId }
 * Pushes any new/changed planned_sessions rows for userId to Google Calendar.
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
    const result = await pushUserSessions(userId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to push sessions to Google Calendar." },
      { status: 500 }
    );
  }
}
