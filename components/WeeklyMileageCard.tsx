"use client";

import { useCallback, useEffect, useState } from "react";

/** Matches the event WeeklyPlanCard broadcasts after any session completed/skipped-state change. */
const SESSIONS_CHANGED_EVENT = "marathon:sessions-changed";

interface WeeklyMileage {
  mode: "estimated" | "actual" | "none";
  km: number;
  sessionsWithoutEstimate: number;
  previousWeek: { actualKm: number; hasSessions: boolean };
  deltaPercent: number | null;
  volume: { baselineWeeks: number; baselineAvgKm: number; ratio: number | null; warning: boolean };
}

/** 16.4 → "16,4", 18 → "18". */
function fmtKm(km: number): string {
  return km.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
}

/** Non-breaking space before the % sign, French typography. */
function fmtDelta(pct: number): string {
  return `${pct >= 0 ? "+" : "−"}${Math.abs(pct)} %`;
}

/**
 * Weekly running mileage, shown above the week's plan. Estimated (planner
 * duration→distance estimates) while the week is still in progress, actual
 * (matched Garmin activities) once every running session is resolved — see
 * app/api/plan/weekly-mileage/route.ts. Non-impact cardio is excluded.
 */
export default function WeeklyMileageCard() {
  const [data, setData] = useState<WeeklyMileage | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/plan/weekly-mileage");
      const json = await r.json();
      if (r.ok && !json.error) setData(json);
    } catch {
      // Best-effort — leave the previous figure (or nothing) displayed.
    }
  }, []);

  useEffect(() => {
    void load();
    window.addEventListener(SESSIONS_CHANGED_EVENT, load);
    return () => window.removeEventListener(SESSIONS_CHANGED_EVENT, load);
  }, [load]);

  if (!data) return null;

  return (
    <div className="border border-gray-200 rounded-lg p-4">
      <h2 className="text-sm font-medium text-gray-700 mb-2">Volume de la semaine</h2>

      {data.mode === "none" ? (
        <p className="text-xs text-gray-500">Aucune sortie course à pied planifiée cette semaine.</p>
      ) : (
        <>
          <div className="flex items-baseline gap-3 flex-wrap">
            <span className="text-2xl font-semibold text-gray-800 tabular-nums">
              {data.mode === "estimated" ? "≈ " : ""}
              {fmtKm(data.km)} km
            </span>
            <span className="text-xs text-gray-500">
              {data.mode === "estimated" ? "prévus" : "réalisés"}
            </span>
            {/* Deliberately neutral — this is information, not a target to beat. */}
            <span
              className="text-xs text-gray-600 tabular-nums border border-gray-200 bg-gray-50 rounded px-1.5 py-0.5"
              title={
                data.deltaPercent !== null
                  ? `Semaine dernière : ${fmtKm(data.previousWeek.actualKm)} km réalisés`
                  : data.previousWeek.hasSessions
                    ? "Aucun kilomètre réalisé la semaine dernière — pas de comparaison possible."
                    : "Pas de semaine précédente à comparer."
              }
            >
              {data.deltaPercent !== null ? fmtDelta(data.deltaPercent) : "—"} vs semaine dernière
            </span>
          </div>

          {data.volume.ratio !== null && (
            <p className={`text-xs mt-2 ${data.volume.warning ? "text-gray-700" : "text-gray-500"}`}>
              {data.volume.warning && "Semaine nettement au-dessus de ta moyenne des 4 dernières semaines — "}
              <span className="tabular-nums">
                ×{data.volume.ratio.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>{" "}
              vs moyenne réalisée des {data.volume.baselineWeeks} dernières semaines ({fmtKm(data.volume.baselineAvgKm)}{" "}
              km/sem.)
            </p>
          )}

          {data.mode === "estimated" && (
            <p className="text-[11px] text-gray-400 mt-1.5">
              Estimation à partir des durées planifiées
              {data.sessionsWithoutEstimate > 0 && (
                <>
                  {" "}— hors {data.sessionsWithoutEstimate} séance
                  {data.sessionsWithoutEstimate > 1 ? "s" : ""} de qualité, prescrite
                  {data.sessionsWithoutEstimate > 1 ? "s" : ""} en durée
                </>
              )}
              .
            </p>
          )}
        </>
      )}
    </div>
  );
}
