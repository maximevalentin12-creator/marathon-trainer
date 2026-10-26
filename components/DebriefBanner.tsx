"use client";

import { useCallback, useEffect, useState } from "react";
import type { PendingDebrief } from "@/lib/debrief/types";
import DebriefSheet, { DEBRIEF_SAVED_EVENT } from "@/components/DebriefSheet";

function fmtDate(iso: string): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

/** "Aujourd'hui" banner: the most recent synced activity that has no debrief yet. */
export default function DebriefBanner() {
  const [pending, setPending] = useState<PendingDebrief[]>([]);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/debriefs");
      const data = await r.json();
      if (r.ok && Array.isArray(data.pending)) setPending(data.pending);
    } catch {
      // Best-effort: no banner if this fails.
    }
  }, []);

  useEffect(() => {
    void load();
    window.addEventListener(DEBRIEF_SAVED_EVENT, load);
    return () => window.removeEventListener(DEBRIEF_SAVED_EVENT, load);
  }, [load]);

  const next = pending[0];
  if (!next) return null;

  const details = [
    next.durationMinutes != null ? `${next.durationMinutes} min` : null,
    next.distanceKm != null ? `${next.distanceKm.toLocaleString("fr-FR")} km` : null,
  ].filter(Boolean);

  return (
    <>
      <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3">
        <p className="text-sm font-medium text-green-900">Comment s&apos;est passée ta sortie ?</p>
        <p className="text-xs text-green-800/80 mt-0.5">
          {next.label} · {fmtDate(next.date)}
          {details.length > 0 ? ` · ${details.join(" · ")}` : ""}
          {pending.length > 1 ? ` — et ${pending.length - 1} autre${pending.length > 2 ? "s" : ""} sans débrief` : ""}
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-2 min-h-[44px] w-full rounded-lg bg-green-700 text-sm font-medium text-white"
        >
          Faire le débrief (1 min)
        </button>
      </div>
      {open && (
        <DebriefSheet
          target={{
            garminActivityId: next.garminActivityId,
            plannedSessionId: next.plannedSessionId,
            date: next.date,
            label: `${next.label} · ${fmtDate(next.date)}`,
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
