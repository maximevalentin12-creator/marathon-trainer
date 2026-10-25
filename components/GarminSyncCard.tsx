"use client";

import { useState } from "react";

interface SyncResponse {
  ok: boolean;
  error?: string;
  mode?: "scheduled" | "local";
  lastImportAt?: string | null;
  completion?: { matched?: number };
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
}

/**
 * Locally this imports from Garmin. In production Python cannot run, so activities arrive through the scheduled
 * job (7 h and 20 h, heure de Paris) and the button only refreshes the matching with the planned sessions.
 */
export default function GarminSyncCard() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SyncResponse | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/garmin/sync", { method: "POST" });
      setResult(await res.json());
    } catch {
      setResult({ ok: false, error: "La synchronisation a échoué." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="text-xs text-gray-500 mb-3">
        Tes activités Garmin sont importées automatiquement chaque jour à 7 h et à 20 h (heure de Paris). Ce bouton
        rapproche les nouvelles activités de tes séances prévues.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={run}
        className="px-4 py-2.5 min-h-[44px] text-sm font-medium text-white bg-gray-800 rounded-lg hover:bg-gray-700 disabled:opacity-50 transition-colors"
      >
        {busy ? "Actualisation…" : "Actualiser mes séances"}
      </button>
      {result && (
        <p className={`mt-3 text-sm ${result.ok ? "text-gray-700" : "text-red-600"}`}>
          {result.ok
            ? `${result.completion?.matched ?? 0} séance(s) rapprochée(s).` +
              (result.lastImportAt ? ` Dernier import : ${fmtDateTime(result.lastImportAt)}.` : "")
            : (result.error ?? "La synchronisation a échoué.")}
        </p>
      )}
    </div>
  );
}
