import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import {
  createDebrief,
  legacyPainScore,
  loadDebriefPlannerInput,
  loadPendingDebriefs,
  parseDebriefInput,
} from "@/lib/debrief";
import { addDays, isoDate, toMonday } from "@/lib/planner";
import { downgradeUpcomingSessions } from "@/lib/planner/liveDowngrade";

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

    // Re-apply the pain rules to the rest of this week, like the old log form does on save. Best-effort.
    try {
      const maxIntensity = Math.max(0, ...(input.pain ?? []).map((p) => p.intensity));
      const painScore = legacyPainScore({
        date: input.date,
        energy: input.energy,
        hasPain: (input.pain ?? []).length > 0,
        maxIntensity,
        affectsGait: false,
      });
      const today = isoDate(new Date());
      const { qualityBlock } = await loadDebriefPlannerInput(auth.db, auth.userId, input.date, today);
      await downgradeUpcomingSessions(auth.db, auth.userId, input.date, painScore, input.energy, {
        from: input.date > today ? input.date : today,
        through: isoDate(addDays(toMonday(new Date()), 6)),
        qualityBlock,
      });
    } catch (err) {
      console.warn(`Skipped upcoming-session downgrade after debrief for user ${auth.userId}:`, err instanceof Error ? err.message : err);
    }

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
