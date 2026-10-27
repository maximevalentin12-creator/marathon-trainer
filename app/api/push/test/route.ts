import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import { sendPushToUser } from "@/lib/push";

/** POST /api/push/test — sends one test notification to every subscription of the signed-in user. */
export async function POST() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  try {
    const result = await sendPushToUser(auth.db, auth.userId, auth.email, {
      title: "Marathon",
      body: "Notification de test : tout fonctionne.",
      url: "/plus",
      tag: "push-test",
    });
    if (result.subscriptions === 0) return NextResponse.json({ error: "Aucun appareil abonné. Active d'abord les notifications.", ...result }, { status: 404 });
    if (result.sent === 0) return NextResponse.json({ error: "Le service de notifications a refusé l'envoi.", ...result }, { status: 502 });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Erreur." }, { status: 500 });
  }
}
