"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { MACHINE_LABEL_FR } from "@/lib/planner";
import CompletionCartouche from "@/components/CompletionCartouche";
import type { HistoryResponse, HistoryRow, HistoryStatus, HistoryWeek } from "@/lib/history/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function fmtWeekRange(weekStartIso: string): string {
  const start = new Date(weekStartIso + "T12:00:00Z");
  const end = new Date(start.getTime() + 6 * 86_400_000);
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", timeZone: "UTC" };
  return `${start.toLocaleDateString("fr-FR", opts)} – ${end.toLocaleDateString("fr-FR", { ...opts, year: "numeric" })}`;
}

function fmtPace(sec: number | null): string {
  if (!sec) return "—";
  const m = Math.floor(sec / 60);
  const s = String(Math.round(sec % 60)).padStart(2, "0");
  return `${m}:${s}/km`;
}

/** 16.4 → "16,4", 18 → "18". */
function fmtKm(km: number): string {
  return km.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
}

/** "45 → 48 min", "45 min" (planned only), "→ 48 min" (actual only), "—". */
function fmtPlannedVsActual(planned: number | null | undefined, actual: number | null | undefined, unit: string): string {
  const p = planned != null ? fmtKm(planned) : null;
  const a = actual != null ? fmtKm(actual) : null;
  if (p && a) return `${p} → ${a} ${unit}`;
  if (p) return `${p} ${unit}`;
  if (a) return `→ ${a} ${unit}`;
  return "—";
}

const STATUS_LABEL: Record<HistoryStatus, string> = {
  completed: "Complétée",
  skipped: "Non réalisée",
  unmatched: "Non appariée",
  off_plan: "Hors plan",
};

const STATUS_CLASS: Record<HistoryStatus, string> = {
  completed: "text-green-700 bg-green-50 border-green-200",
  skipped: "text-red-700 bg-red-50 border-red-200",
  unmatched: "text-amber-700 bg-amber-50 border-amber-200",
  off_plan: "text-gray-600 bg-white border-dashed border-gray-300",
};

/** Non-impact / other rows get a colored left edge so they read apart from running at a glance. */
const MODALITY_EDGE: Record<HistoryRow["modality"], string> = {
  running: "border-l-transparent",
  non_impact: "border-l-sky-300",
  other: "border-l-gray-300",
};

function isExpandable(r: HistoryRow): boolean {
  return r.status === "completed";
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: HistoryStatus }) {
  return (
    <span
      className={`inline-block whitespace-nowrap text-[10px] uppercase tracking-wide border rounded px-1.5 py-0.5 ${STATUS_CLASS[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function ModalityBadge({ row }: { row: HistoryRow }) {
  if (row.modality === "non_impact") {
    return (
      <span className="text-[10px] uppercase tracking-wide text-sky-700 border border-sky-200 bg-sky-50 rounded px-1.5 py-0.5">
        Cardio{row.machine ? ` · ${MACHINE_LABEL_FR[row.machine]}` : ""}
      </span>
    );
  }
  if (row.modality === "other") {
    return (
      <span className="text-[10px] uppercase tracking-wide text-gray-500 border border-gray-200 rounded px-1.5 py-0.5">
        Autre
      </span>
    );
  }
  if (row.indoor) {
    return (
      <span className="text-[10px] uppercase tracking-wide text-gray-400 border border-gray-200 rounded px-1.5 py-0.5">
        Tapis
      </span>
    );
  }
  return null;
}

function ExpandedDetail({ row }: { row: HistoryRow }) {
  return (
    <CompletionCartouche
      score={row.completionScore}
      note={row.completionNote}
      analysis={row.completionAnalysis}
      result={row.isRace ? (row.actual ?? { durationSeconds: null, distanceKm: null, avgPaceSecPerKm: null, avgHeartRate: null }) : null}
    />
  );
}

function WeekHeader({ week }: { week: HistoryWeek }) {
  return (
    <div className="flex items-baseline justify-between gap-3 flex-wrap mb-2">
      <h2 className="text-sm font-medium text-gray-700">Semaine du {fmtWeekRange(week.weekStart)}</h2>
      <p className="text-xs text-gray-500 tabular-nums">
        <span className="font-semibold text-gray-800">{fmtKm(week.runningKm)} km</span> course
        {" · "}
        {week.completedCount}/{week.plannedCount} séance{week.plannedCount > 1 ? "s" : ""} réalisée
        {week.completedCount > 1 ? "s" : ""}
        {week.offPlanCount > 0 && (
          <>
            {" · "}+{week.offPlanCount} hors plan
            {week.offPlanRunningKm > 0 && ` (${fmtKm(week.offPlanRunningKm)} km)`}
          </>
        )}
      </p>
    </div>
  );
}

function WeekTable({
  week,
  expanded,
  onToggle,
}: {
  week: HistoryWeek;
  expanded: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="hidden md:block overflow-x-auto border border-gray-200 rounded-lg">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-gray-400 border-b border-gray-100">
            <th className="px-3 py-2 font-medium">Date</th>
            <th className="px-3 py-2 font-medium">Séance</th>
            <th className="px-3 py-2 font-medium">Statut</th>
            <th className="px-3 py-2 font-medium">Durée</th>
            <th className="px-3 py-2 font-medium">Distance</th>
            <th className="px-3 py-2 font-medium">Allure</th>
            <th className="px-3 py-2 font-medium">FC moy</th>
            <th className="px-3 py-2 font-medium">Score</th>
            <th className="px-3 py-2 font-medium">Paire</th>
            <th className="px-2 py-2" />
          </tr>
        </thead>
        <tbody>
          {week.rows.map((r) => {
            const canExpand = isExpandable(r);
            const isOpen = expanded.has(r.id);
            return (
              <Fragment key={r.id}>
                <tr
                  onClick={canExpand ? () => onToggle(r.id) : undefined}
                  className={`border-b border-gray-100 last:border-b-0 border-l-4 ${MODALITY_EDGE[r.modality]} ${
                    canExpand ? "cursor-pointer hover:bg-gray-50" : ""
                  } ${r.modality !== "running" ? "text-gray-500" : "text-gray-700"}`}
                >
                  <td className="px-3 py-2 whitespace-nowrap capitalize text-gray-500">{fmtDate(r.date)}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-medium">{r.label}</span>
                      <ModalityBadge row={r} />
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                    {fmtPlannedVsActual(r.planned?.durationMinutes, r.actual?.durationMinutes, "min")}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                    {fmtPlannedVsActual(r.planned?.distanceKm, r.actual?.distanceKm, "km")}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                    {r.modality === "running" ? fmtPace(r.actual?.avgPaceSecPerKm ?? null) : "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                    {r.actual?.avgHeartRate != null ? `${r.actual.avgHeartRate} bpm` : "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums font-semibold">
                    {r.completionScore != null ? `${r.completionScore}%` : "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-500">{r.shoe?.name ?? "—"}</td>
                  <td className="px-2 py-2 text-gray-400 w-4">{canExpand ? (isOpen ? "▾" : "▸") : ""}</td>
                </tr>
                {canExpand && isOpen && (
                  <tr className={`border-b border-gray-100 last:border-b-0 border-l-4 ${MODALITY_EDGE[r.modality]}`}>
                    <td colSpan={10} className="px-3 pb-3 pt-1">
                      <ExpandedDetail row={r} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function WeekCards({
  week,
  expanded,
  onToggle,
}: {
  week: HistoryWeek;
  expanded: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="md:hidden space-y-2">
      {week.rows.map((r) => {
        const canExpand = isExpandable(r);
        const isOpen = expanded.has(r.id);
        return (
          <div
            key={r.id}
            className={`border border-gray-200 border-l-4 ${MODALITY_EDGE[r.modality]} rounded-lg p-3 ${
              r.modality !== "running" ? "text-gray-500" : "text-gray-700"
            }`}
          >
            <button
              type="button"
              disabled={!canExpand}
              onClick={() => onToggle(r.id)}
              className="w-full text-left disabled:cursor-default"
            >
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <span className="text-[11px] text-gray-400 capitalize">{fmtDate(r.date)}</span>
                <StatusBadge status={r.status} />
              </div>
              <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
                <span className="text-sm font-medium">{r.label}</span>
                <ModalityBadge row={r} />
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs tabular-nums">
                <dt className="text-gray-400">Durée</dt>
                <dd>{fmtPlannedVsActual(r.planned?.durationMinutes, r.actual?.durationMinutes, "min")}</dd>
                <dt className="text-gray-400">Distance</dt>
                <dd>{fmtPlannedVsActual(r.planned?.distanceKm, r.actual?.distanceKm, "km")}</dd>
                {r.modality === "running" && r.actual?.avgPaceSecPerKm != null && (
                  <>
                    <dt className="text-gray-400">Allure</dt>
                    <dd>{fmtPace(r.actual.avgPaceSecPerKm)}</dd>
                  </>
                )}
                {r.actual?.avgHeartRate != null && (
                  <>
                    <dt className="text-gray-400">FC moy</dt>
                    <dd>{r.actual.avgHeartRate} bpm</dd>
                  </>
                )}
                {r.completionScore != null && (
                  <>
                    <dt className="text-gray-400">Score</dt>
                    <dd className="font-semibold">{r.completionScore}%</dd>
                  </>
                )}
                {r.shoe && (
                  <>
                    <dt className="text-gray-400">Paire</dt>
                    <dd>{r.shoe.name}</dd>
                  </>
                )}
              </dl>
              {canExpand && (
                <p className="text-[10px] text-gray-400 mt-1.5">{isOpen ? "▾ Masquer l'analyse" : "▸ Voir l'analyse"}</p>
              )}
            </button>
            {canExpand && isOpen && (
              <div className="mt-2">
                <ExpandedDetail row={r} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type Phase = "loading" | "ready" | "no-user";

export default function HistoriquePage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [userId, setUserId] = useState<string | null>(null);
  const [weeks, setWeeks] = useState<HistoryWeek[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const loadPage = useCallback(async (uid: string, before: string | null) => {
    setError(null);
    const qs = new URLSearchParams({ userId: uid });
    if (before) qs.set("before", before);
    try {
      const r = await fetch(`/api/history?${qs}`);
      const data: HistoryResponse & { error?: string } = await r.json();
      if (!r.ok || data.error) {
        setError(data.error ?? "Impossible de charger l'historique.");
        return;
      }
      // Pages are disjoint week ranges, so appending keeps newest-first order.
      setWeeks((prev) => (before ? [...prev, ...data.weeks] : data.weeks));
      setNextBefore(data.nextBefore);
    } catch {
      setError("Impossible de charger l'historique.");
    }
  }, []);

  useEffect(() => {
    const id = localStorage.getItem("marathon_user_id");
    if (!id) {
      setPhase("no-user");
      return;
    }
    setUserId(id);
    void loadPage(id, null).then(() => setPhase("ready"));
  }, [loadPage]);

  async function handleLoadMore() {
    if (!userId || !nextBefore) return;
    setLoadingMore(true);
    await loadPage(userId, nextBefore);
    setLoadingMore(false);
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <main className="max-w-5xl mx-auto px-4 py-12 pb-24">
      <a href="/" className="text-xs text-gray-400 hover:text-gray-600 block mb-6">
        ← Dashboard
      </a>
      <header className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">Historique</h1>
        <p className="mt-1 text-sm text-gray-500">
          Toutes tes séances passées, semaine par semaine — y compris les sorties hors plan. Les km par semaine
          ne comptent que la course à pied planifiée ; le cardio sans impact est signalé par un liseré bleu.
        </p>
      </header>

      {phase === "no-user" && (
        <p className="text-xs text-gray-500">
          <a href="/onboarding" className="underline">
            Complète ton profil
          </a>{" "}
          pour voir ton historique.
        </p>
      )}

      {phase === "loading" && <p className="text-xs text-gray-400">Chargement…</p>}

      {error && <p className="text-xs text-red-500 mb-4">{error}</p>}

      {phase === "ready" && (
        <>
          {weeks.length === 0 && !error && (
            <p className="text-xs text-gray-400">Aucune séance passée pour l&apos;instant.</p>
          )}

          <div className="space-y-8">
            {weeks.map((w) => (
              <section key={w.weekStart}>
                <WeekHeader week={w} />
                <WeekTable week={w} expanded={expanded} onToggle={toggle} />
                <WeekCards week={w} expanded={expanded} onToggle={toggle} />
              </section>
            ))}
          </div>

          {nextBefore && (
            <div className="mt-8 text-center">
              <button
                type="button"
                disabled={loadingMore}
                onClick={handleLoadMore}
                className="px-4 py-2 text-xs font-medium border border-gray-200 text-gray-600 rounded hover:border-gray-400 disabled:opacity-50 transition-colors"
              >
                {loadingMore ? "Chargement…" : "Semaines précédentes →"}
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
