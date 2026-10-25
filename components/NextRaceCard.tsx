"use client";

import { useEffect, useState } from "react";
import { PHASE_LABEL_FR, PHASE_STYLE, PHASE_WHY_FR } from "@/lib/planner";
import { fmtDateLongFr } from "@/lib/dateFr";
import type { PlanOverview } from "@/lib/racePlanOverview";

/** "Prochaine course" on the home screen: the goal race, its countdown and the phase the plan is in. */
export default function NextRaceCard() {
  const [overview, setOverview] = useState<PlanOverview | null | undefined>(undefined);

  useEffect(() => {
    const userId = localStorage.getItem("marathon_user_id");
    if (!userId) {
      setOverview(null);
      return;
    }
    fetch(`/api/plan/overview?userId=${userId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setOverview)
      .catch(() => setOverview(null));
  }, []);

  if (overview === undefined) return <p className="text-sm text-gray-500">Chargement…</p>;

  const goal = overview?.goal;
  if (!overview || !goal) {
    return (
      <div>
        <p className="text-sm text-gray-700">Pas de course objectif pour l&apos;instant.</p>
        <a href="/plan#courses" className="mt-2 inline-block min-h-[44px] py-2.5 text-sm font-medium text-accent underline">
          Ajouter une course →
        </a>
      </div>
    );
  }

  const days = Math.round((Date.parse(goal.date) - Date.parse(overview.today)) / 86_400_000);
  const week = overview.weeks.find((w) => w.weekStart === overview.currentWeekStart) ?? null;

  return (
    <div>
      <p className="text-sm text-gray-900">
        <span className="text-xl font-semibold tabular-nums">{days === 0 ? "Jour J" : `J-${days}`}</span>
        <span className="mx-2 text-gray-300">·</span>
        {goal.name}
      </p>
      <p className="text-xs text-gray-500 mt-0.5">
        {fmtDateLongFr(goal.date)} · {String(goal.distanceKm).replace(".", ",")} km
      </p>
      {week && (
        <div className="mt-3">
          <span className={`inline-block text-xs font-medium rounded-full px-2.5 py-1 ${PHASE_STYLE[week.phase].chip}`}>
            {PHASE_LABEL_FR[week.phase]}
          </span>
          <p className="mt-1.5 text-xs text-gray-600">{PHASE_WHY_FR[week.phase]}</p>
        </div>
      )}
      <a href="/plan" className="mt-3 inline-block min-h-[44px] py-2.5 text-sm font-medium text-accent underline">
        Voir le plan →
      </a>
    </div>
  );
}
