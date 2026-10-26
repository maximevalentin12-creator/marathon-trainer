import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import { createDebrief, loadPendingDebriefs, parseDebriefInput } from "@/lib/debrief";
import { isoDate } from "@/lib/planner";

/** GET /api/debriefs — synced activities of the last 3 weeks that still need a debrief. */
export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({ pending: await loadPendingDebriefs(auth.db, auth.userId, isoDate(new Date())) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Erreur." }, { status: 500 });
  }
}

/** POST /api/debriefs — a DebriefInput (see lib/debrief/types.ts). One debrief per activity. */
export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Corps JSON invalide." }, { status: 400 });
  }
  const [input, problem] = parseDebriefInput(body);
  if (!input) return NextResponse.json({ error: problem }, { status: 400 });
  try {
    const { id } = await createDebrief(auth.db, auth.userId, input);
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur.";
    const duplicate = /debriefs_activity_uniq|duplicate key/i.test(message);
    return NextResponse.json(
      { error: duplicate ? "Cette sortie a déjà un débrief." : message },
      { status: duplicate ? 409 : 500 }
    );
  }
}
