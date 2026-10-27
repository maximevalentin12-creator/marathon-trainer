import webpush from "web-push";
import type { UserDb } from "@/lib/auth/server";

export type PushPayload = { title: string; body: string; url?: string; tag?: string };
export type PushResult = { sent: number; removed: number; failed: number; subscriptions: number };

/**
 * Sends a notification to every subscription of the user (RLS on `db` already limits rows to them).
 * A subscription the push service reports gone (404/410) is deleted.
 */
export async function sendPushToUser(db: UserDb, userId: string, email: string | null, payload: PushPayload): Promise<PushResult> {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) throw new Error("Clés VAPID absentes : NEXT_PUBLIC_VAPID_PUBLIC_KEY et VAPID_PRIVATE_KEY.");
  const subject = process.env.VAPID_SUBJECT ?? (email ? `mailto:${email}` : undefined);
  if (!subject) throw new Error("VAPID_SUBJECT absent (ex. mailto:toi@exemple.com).");
  webpush.setVapidDetails(subject, publicKey, privateKey);

  const { data, error } = await db.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", userId);
  if (error) throw new Error(error.message);
  const subs = data ?? [];

  const result: PushResult = { sent: 0, removed: 0, failed: 0, subscriptions: subs.length };
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 3600 });
        result.sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await db.from("push_subscriptions").delete().eq("id", s.id);
          result.removed++;
        } else {
          console.warn("push failed", status, err instanceof Error ? err.message : err);
          result.failed++;
        }
      }
    })
  );
  return result;
}
