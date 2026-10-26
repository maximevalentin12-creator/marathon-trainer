import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import { downgradeUpcomingSessions } from "@/lib/planner/liveDowngrade";

/**
 * POST /api/log/save
 * Body: { entryDate, moodScore, energyScore, painScore,
 *         injuryNotes?, strainNotes?, overallNotes?, sessionId? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { userId, db } = auth;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body." }, { status: 400 });

  const {
    entryDate,
    moodScore,
    energyScore,
    painScore,
    injuryNotes,
    strainNotes,
    overallNotes,
    sessionId,
  } = body as {
    entryDate: string;
    moodScore: number;
    energyScore: number;
    painScore: number;
    injuryNotes?: string;
    strainNotes?: string;
    overallNotes?: string;
    sessionId?: string;
  };

  if (!entryDate) {
    return NextResponse.json({ error: "entryDate is required." }, { status: 400 });
  }

  if (
    !Number.isInteger(moodScore) || moodScore < 1 || moodScore > 5 ||
    !Number.isInteger(energyScore) || energyScore < 1 || energyScore > 5 ||
    !Number.isInteger(painScore) || painScore < 0 || painScore > 5
  ) {
    return NextResponse.json({ error: "Invalid score value." }, { status: 400 });
  }

  const { error } = await db.from("subjective_entries").insert({
    user_id: userId,
    entry_date: entryDate,
    mood_score: moodScore,
    energy_score: energyScore,
    pain_score: painScore,
    injury_notes: injuryNotes?.trim() || null,
    strain_notes: strainNotes?.trim() || null,
    overall_notes: overallNotes?.trim() || null,
    session_id: sessionId || null,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  try {
    await downgradeUpcomingSessions(db, userId, entryDate, painScore, energyScore);
  } catch (err) {
    console.warn(`Skipped upcoming-session downgrade check for user ${userId}:`, err instanceof Error ? err.message : err);
  }

  return NextResponse.json({ ok: true });
}
