import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import { loadEpisodeHistory, resolveStaleEpisodes } from "@/lib/debrief";
import { isoDate } from "@/lib/planner";

/** GET /api/injuries — every injury episode (open first) with its dated reports. */
export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  try {
    await resolveStaleEpisodes(auth.db, auth.userId, isoDate(new Date()));
    return NextResponse.json({ episodes: await loadEpisodeHistory(auth.db, auth.userId) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Erreur." }, { status: 500 });
  }
}
