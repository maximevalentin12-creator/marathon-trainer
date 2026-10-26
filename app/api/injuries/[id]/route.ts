import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import { markEpisodeResolved } from "@/lib/debrief";
import { isoDate } from "@/lib/planner";

/** PATCH /api/injuries/:id — body { resolved: true } marks an open episode resolved today. */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const body = (await req.json().catch(() => ({}))) as { resolved?: unknown };
  if (body.resolved !== true) {
    return NextResponse.json({ error: "Seul { resolved: true } est géré." }, { status: 400 });
  }
  try {
    const done = await markEpisodeResolved(auth.db, auth.userId, params.id, isoDate(new Date()));
    return done
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "Épisode introuvable ou déjà résolu." }, { status: 404 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Erreur." }, { status: 500 });
  }
}
