"use client";

import { useCallback, useEffect, useState } from "react";

type State = "loading" | "unsupported" | "not-installed" | "denied" | "inactive" | "active";

const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function keyToBytes(base64Url: string): Uint8Array {
  const base64 = (base64Url + "=".repeat((4 - (base64Url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function send(endpoint: string, method: "POST" | "DELETE", body?: unknown): Promise<Response> {
  return fetch(endpoint, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
}

/** "Recevoir les notifications" toggle + test button. iOS only asks for permission from a tap in the installed app. */
export default function PushNotificationsCard() {
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // Not running from the home-screen icon: say so first (iOS exposes no push API in a Safari tab).
    if (!isStandalone()) return setState("not-installed");
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return setState("unsupported");
    if (Notification.permission === "denied") return setState("denied");
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub && Notification.permission === "granted") {
      // Refresh last_seen_at, and re-create the row if the server lost it.
      void send("/api/push/subscribe", "POST", sub.toJSON()).catch(() => {});
      return setState("active");
    }
    setState("inactive");
  }, []);

  useEffect(() => {
    void refresh().catch(() => setState("unsupported"));
  }, [refresh]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Erreur.");
    } finally {
      setBusy(false);
    }
  }

  const enable = () =>
    run(async () => {
      if (!PUBLIC_KEY) throw new Error("Clé VAPID publique absente (NEXT_PUBLIC_VAPID_PUBLIC_KEY).");
      // iOS only shows the prompt when this is called straight from the tap, before any other await.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return setState(permission === "denied" ? "denied" : "inactive");
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(PUBLIC_KEY) as BufferSource }));
      const res = await send("/api/push/subscribe", "POST", sub.toJSON());
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Enregistrement impossible.");
      setState("active");
    });

  const disable = () =>
    run(async () => {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await send("/api/push/subscribe", "DELETE", { endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setState("inactive");
    });

  const sendTest = () =>
    run(async () => {
      const res = await send("/api/push/test", "POST");
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? "Envoi impossible.");
      setMessage("Notification envoyée : elle arrive dans quelques secondes.");
    });

  const status: Record<State, string> = {
    loading: "Vérification…",
    unsupported: "Cet appareil ne gère pas les notifications.",
    "not-installed": "Ouvre l'app depuis son icône sur l'écran d'accueil pour activer les notifications.",
    denied: "Refusées. Autorise-les dans Réglages > Notifications > Marathon, puis reviens ici.",
    inactive: "Désactivées sur cet appareil.",
    active: "Activées sur cet appareil.",
  };

  const button = "w-full px-4 py-3 min-h-[44px] text-sm font-medium rounded-lg disabled:opacity-50";

  return (
    <div>
      <p className="text-xs text-gray-500 mb-3" role="status">{status[state]}</p>
      {state === "inactive" && (
        <button type="button" disabled={busy} onClick={enable} className={`${button} bg-accent text-white`}>
          Recevoir les notifications
        </button>
      )}
      {state === "active" && (
        <div className="space-y-2">
          <button type="button" disabled={busy} onClick={sendTest} className={`${button} bg-accent text-white`}>
            Envoyer une notification de test
          </button>
          <button type="button" disabled={busy} onClick={disable} className={`${button} border border-gray-300 text-gray-700 hover:border-gray-500`}>
            Désactiver les notifications
          </button>
        </div>
      )}
      {message && <p className="text-xs text-gray-600 mt-3">{message}</p>}
    </div>
  );
}
