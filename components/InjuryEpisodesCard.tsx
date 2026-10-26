"use client";

import { useCallback, useEffect, useState } from "react";
import type { InjuryEpisodeHistory } from "@/lib/debrief/types";
import { ONSET_LABEL_FR, zoneWithSideFr } from "@/lib/debrief/labels";

function fmtDay(iso: string): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
}

function Episode({
  episode,
  busy,
  onResolve,
}: {
  episode: InjuryEpisodeHistory;
  busy: boolean;
  onResolve: (id: string) => void;
}) {
  const open = episode.resolvedOn === null;
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900">{zoneWithSideFr(episode.zone, episode.side)}</p>
          <p className="text-xs text-gray-500">
            Depuis le {fmtDay(episode.startedOn)}
            {open ? "" : ` · résolue le ${fmtDay(episode.resolvedOn!)}`} · pic {episode.peakIntensity}/10
            {episode.affectsGait ? " · change la foulée" : ""}
          </p>
        </div>
        {open && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onResolve(episode.id)}
            className="shrink-0 min-h-[44px] rounded-lg border border-gray-300 px-3 text-xs text-gray-700 hover:border-gray-500 disabled:opacity-50"
          >
            Marquer résolue
          </button>
        )}
      </div>
      {episode.reports.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {episode.reports.map((r, i) => (
            <li key={i} className="text-xs text-gray-500 flex justify-between gap-2">
              <span>
                {fmtDay(r.date)} · {ONSET_LABEL_FR[r.onset].toLowerCase()}
                {r.affectsGait ? " · foulée" : ""}
              </span>
              <span className="tabular-nums text-gray-700">{r.intensity}/10</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** "Mes douleurs": open episodes with their report history, then the resolved ones. */
export default function InjuryEpisodesCard() {
  const [episodes, setEpisodes] = useState<InjuryEpisodeHistory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/injuries");
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error);
      setEpisodes(data.episodes);
    } catch {
      setError("Impossible de charger tes douleurs.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const r = await fetch(`/api/injuries/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolved: true }),
      });
      const data = await r.json();
      if (!r.ok || data.error) setError(data.error ?? "La mise à jour a échoué.");
      await load();
    } catch {
      setError("La mise à jour a échoué.");
    } finally {
      setBusyId(null);
    }
  }

  if (error && !episodes) return <p className="text-xs text-red-600">{error}</p>;
  if (!episodes) return <p className="text-xs text-gray-400">Chargement…</p>;

  const open = episodes.filter((e) => e.resolvedOn === null);
  const resolved = episodes.filter((e) => e.resolvedOn !== null);

  return (
    <div className="space-y-4">
      {error && <p className="text-xs text-red-600">{error}</p>}
      {open.length === 0 ? (
        <p className="text-xs text-gray-500">Aucune douleur en cours. Les douleurs signalées dans un débrief apparaîtront ici.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {open.map((e) => (
            <Episode key={e.id} episode={e} busy={busyId === e.id} onResolve={resolve} />
          ))}
        </ul>
      )}
      {resolved.length > 0 && (
        <details className="text-xs text-gray-500">
          <summary className="cursor-pointer select-none min-h-[44px] flex items-center">
            Résolues ({resolved.length})
          </summary>
          <ul className="divide-y divide-gray-100 mt-1">
            {resolved.map((e) => (
              <Episode key={e.id} episode={e} busy={false} onResolve={resolve} />
            ))}
          </ul>
        </details>
      )}
      <p className="text-[11px] text-gray-400">Une douleur sans nouveau signalement pendant 14 jours est marquée résolue automatiquement.</p>
    </div>
  );
}
