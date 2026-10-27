import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";

type Body = { endpoint?: string; keys?: { p256dh?: string; auth?: string } };

/** POST /api/push/subscribe — stores (or refreshes) this device's push subscription. */
export async function POST(req: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const body = (await req.json().catch(() => null)) as Body | null;
  const endpoint = body?.endpoint;
  const p256dh = body?.keys?.p256dh;
  const authKey = body?.keys?.auth;
  if (!endpoint || !p256dh || !authKey) return NextResponse.json({ error: "Abonnement incomplet." }, { status: 400 });

  const { error } = await auth.db.from("push_subscriptions").upsert(
    {
      user_id: auth.userId,
      endpoint,
      p256dh,
      auth: authKey,
      user_agent: req.headers.get("user-agent"),
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "endpoint" }
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

/** DELETE /api/push/subscribe — forgets this device's subscription. */
export async function DELETE(req: Request) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.endpoint) return NextResponse.json({ error: "Endpoint manquant." }, { status: 400 });
  const { error } = await auth.db.from("push_subscriptions").delete().eq("endpoint", body.endpoint).eq("user_id", auth.userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
