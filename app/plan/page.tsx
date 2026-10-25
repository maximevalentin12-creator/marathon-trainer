"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fmtDuration,
  KEY_SESSION_LABEL_FR,
  PHASE_LABEL_FR,
  PHASE_STYLE,
  PHASE_WHY_FR,
} from "@/lib/planner";
import type { PlanOverview, PlanSessionDto, PlanWeekDto } from "@/lib/racePlanOverview";
import RaceSheet from "@/components/RaceSheet";
import { fmtDayMonthFr as fmtDay, fmtWeekdayDayFr as fmtWeekday } from "@/lib/dateFr";

const SESSION_KIND_FR: Record<string, string> = {
  easy: "Footing facile",
  long: "Sortie longue",
  threshold: "Séance au seuil",
  vo2max: "Fractionné court",
  rest: "Repos",
  race: "Course",
};

function fmtRange(week: PlanWeekDto): string {
  return `${fmtDay(week.weekStart)} – ${fmtDay(week.weekEnd)}`;
}

function weeksLabel(n: number): string {
  return n === 0 ? "Semaine de la course" : n === 1 ? "1 semaine avant la course" : `${n} semaines avant la course`;
}

/** Consecutive weeks of the same phase, so each phase gets one header with its sentence. */
function groupByPhase(weeks: PlanWeekDto[]): PlanWeekDto[][] {
  const groups: PlanWeekDto[][] = [];
  for (const w of weeks) {
    const last = groups[groups.length - 1];
    if (last && last[0].phase === w.phase) last.push(w);
    else groups.push([w]);
  }
  return groups;
}

function SessionLine({ s }: { s: PlanSessionDto }) {
  const status = s.completed ? "Fait" : s.skipped ? "Passée" : "";
  return (
    <li className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
      <span className="min-w-0">
        <span className="text-gray-400 tabular-nums mr-2">{fmtWeekday(s.date)}</span>
        <span className="text-gray-800">{s.label ?? SESSION_KIND_FR[s.kind] ?? s.kind}</span>
      </span>
      <span className="shrink-0 text-xs text-gray-500 tabular-nums">
        {s.minutes ? fmtDuration(s.minutes) : ""}
        {s.km ? ` · ${String(s.km).replace(".", ",")} km` : ""}
        {status && <span className="ml-2 text-gray-400">{status}</span>}
      </span>
    </li>
  );
}

function WeekDetail({ week, isCurrent }: { week: PlanWeekDto; isCurrent: boolean }) {
  return (
    <div className="px-3 pb-3 pt-1 border-t border-gray-100 text-sm">
      <p className="text-xs text-gray-400 mb-2">{weeksLabel(week.weeksToRace)}</p>
      {week.sessions.length > 0 ? (
        <ul className="divide-y divide-gray-100">
          {week.sessions.map((s) => (
            <SessionLine key={s.id} s={s} />
          ))}
        </ul>
      ) : (
        <div>
          <p className="text-xs text-gray-500 mb-1.5">
            Semaine pas encore générée. Voici ce que le plan prévoit :
          </p>
          <ul className="space-y-1 text-gray-800">
            <li>
              {week.raceNames.length > 0 ? "Volume (course incluse pour une course de préparation)" : "Volume"} :{" "}
              <span className="font-medium">{week.targetKm} km</span>
            </li>
            {week.longRunMin > 0 && (
              <li>
                Sortie longue : <span className="font-medium">{fmtDuration(week.longRunMin)}</span>
                {week.mpKm > 0 && <> dont {week.mpKm} km à allure marathon</>}
              </li>
            )}
            <li>
              Séance clé : <span className="font-medium">{KEY_SESSION_LABEL_FR[week.keySession]}</span>
            </li>
          </ul>
        </div>
      )}
      {week.notes.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-gray-500 list-disc pl-4">
          {week.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {isCurrent && (
        <a href="/" className="mt-3 inline-block text-xs font-medium text-accent underline">
          Ouvrir la semaine dans « Aujourd&apos;hui » →
        </a>
      )}
    </div>
  );
}

function WeekRow({
  week,
  isCurrent,
  open,
  onToggle,
  innerRef,
}: {
  week: PlanWeekDto;
  isCurrent: boolean;
  open: boolean;
  onToggle: () => void;
  innerRef?: (el: HTMLDivElement | null) => void;
}) {
  const style = PHASE_STYLE[week.phase];
  return (
    <div
      ref={innerRef}
      className={`flex bg-white rounded-lg overflow-hidden border ${
        isCurrent ? "border-accent ring-2 ring-accent/30" : "border-gray-200"
      }`}
    >
      <div className={`w-1.5 shrink-0 ${style.band}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="w-full text-left px-3 py-2.5 min-h-[64px] flex flex-col gap-1"
        >
          <span className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-gray-900">{fmtRange(week)}</span>
            <span className="flex items-center gap-1.5 shrink-0">
              {isCurrent && <span className="text-[11px] font-medium text-white bg-accent rounded-full px-2 py-0.5">Cette semaine</span>}
              {week.phase === "taper" && <span className={`text-[11px] rounded-full px-2 py-0.5 ${style.chip}`}>Affûtage</span>}
              {week.isDeload && <span className="text-[11px] rounded-full px-2 py-0.5 bg-teal-50 text-teal-800">Allégée</span>}
            </span>
          </span>
          <span className="text-sm text-gray-700 tabular-nums">
            {week.targetKm} km
            {week.longRunMin > 0 && (
              <>
                <span className="text-gray-300"> · </span>
                Longue {fmtDuration(week.longRunMin)}
              </>
            )}
            {week.mpKm > 0 && (
              <>
                <span className="text-gray-300"> · </span>
                <span className="text-orange-700">{week.mpKm} km allure marathon</span>
              </>
            )}
          </span>
          <span className="text-xs text-gray-500">
            {KEY_SESSION_LABEL_FR[week.keySession]}
            {week.raceNames.length > 0 && (
              <span className="ml-2 inline-flex items-center gap-1 font-medium text-red-700">
                <span aria-hidden>⚑</span>
                {week.raceNames.join(", ")}
              </span>
            )}
          </span>
        </button>
        {open && <WeekDetail week={week} isCurrent={isCurrent} />}
      </div>
    </div>
  );
}

export default function PlanPage() {
  const [overview, setOverview] = useState<PlanOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openWeek, setOpenWeek] = useState<string | null>(null);
  const currentRef = useRef<HTMLDivElement | null>(null);
  const scrolled = useRef(false);

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch("/api/plan/overview");
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Impossible de charger le plan.");
      setOverview(null);
      return;
    }
    setOverview(data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Bring the current week into view once, when the plan first appears.
  useEffect(() => {
    if (overview && !scrolled.current && currentRef.current) {
      scrolled.current = true;
      currentRef.current.scrollIntoView({ block: "center" });
    }
  }, [overview]);

  const groups = overview ? groupByPhase(overview.weeks) : [];
  const daysToGoal = overview?.goal
    ? Math.round((Date.parse(overview.goal.date) - Date.parse(overview.today)) / 86_400_000)
    : null;

  return (
    <main className="max-w-xl mx-auto px-4 pt-6 pb-24 md:py-10">
      <header className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Plan</h1>
        {overview?.goal && daysToGoal !== null && (
          <p className="mt-1 text-sm text-gray-700">
            {overview.goal.name} · <span className="font-semibold tabular-nums">{daysToGoal === 0 ? "Jour J" : `J-${daysToGoal}`}</span>
          </p>
        )}
      </header>

      <section id="courses" className="mb-8 scroll-mt-4">
        <h2 className="text-base font-semibold mb-3">Mes courses</h2>
        <RaceSheet onChanged={load} />
      </section>
      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {!overview && !error && <p className="text-sm text-gray-500">Chargement…</p>}

      {overview && !overview.goal && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6">
          <p className="text-sm text-gray-800">Pas encore de course objectif.</p>
          <p className="text-xs text-gray-500 mt-1">
            Ajoute-en une ci-dessous : le plan se construit à rebours depuis le jour de la course.
          </p>
        </div>
      )}

      {overview && overview.warnings.length > 0 && (
        <details className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
          <summary className="text-sm font-medium text-amber-900 cursor-pointer min-h-[32px] flex items-center">
            Points d&apos;attention ({overview.warnings.length})
          </summary>
          <ul className="mt-1 mb-1 space-y-1.5 text-xs text-amber-900 list-disc pl-4">
            {overview.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}

      {overview && groups.length > 0 && (
        <div className="space-y-6">
          {groups.map((group) => {
            const phase = group[0].phase;
            return (
              <section key={group[0].weekStart}>
                <div className="mb-2 px-1">
                  <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                    <span className={`inline-block w-2.5 h-2.5 rounded-full ${PHASE_STYLE[phase].band}`} aria-hidden />
                    {PHASE_LABEL_FR[phase]}
                    <span className="text-xs font-normal text-gray-500">
                      · {group.length} semaine{group.length > 1 ? "s" : ""}
                    </span>
                  </h2>
                  <p className="mt-0.5 text-xs text-gray-600">{PHASE_WHY_FR[phase]}</p>
                </div>
                <div className="space-y-2">
                  {group.map((week) => {
                    const isCurrent = week.weekStart === overview.currentWeekStart;
                    return (
                      <WeekRow
                        key={week.weekStart}
                        week={week}
                        isCurrent={isCurrent}
                        open={openWeek === week.weekStart}
                        onToggle={() => setOpenWeek(openWeek === week.weekStart ? null : week.weekStart)}
                        innerRef={isCurrent ? (el) => (currentRef.current = el) : undefined}
                      />
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

    </main>
  );
}
