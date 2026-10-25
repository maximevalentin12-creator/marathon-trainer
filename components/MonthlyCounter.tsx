"use client";

import { useCallback, useEffect, useState } from "react";

/** Matches the event WeeklyPlanCard broadcasts after any session completed/skipped-state change. */
const SESSIONS_CHANGED_EVENT = "marathon:sessions-changed";

interface Counts {
  completed: number;
  skipped: number;
}

/**
 * Dual counter shown at the top of the dashboard: sessions completed vs.
 * skipped this calendar month. Always computed live from planned_sessions
 * (see app/api/reports/monthly-counts/route.ts) — no running total is
 * stored, so it naturally resets at the start of each month.
 */
export default function MonthlyCounter() {
  const [counts, setCounts] = useState<Counts | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/reports/monthly-counts");
      const data = await r.json();
      if (r.ok && !data.error) setCounts({ completed: data.completed, skipped: data.skipped });
    } catch {
      // Best-effort — leave prior counts (or none) displayed.
    }
  }, []);

  useEffect(() => {
    void load();
    window.addEventListener(SESSIONS_CHANGED_EVENT, load);
    return () => window.removeEventListener(SESSIONS_CHANGED_EVENT, load);
  }, [load]);

  if (!counts) return null;

  return (
    <div className="flex items-center gap-6 mb-8">
      <div>
        <span className="text-2xl font-semibold text-green-700 tabular-nums">{counts.completed}</span>
        <span className="ml-2 text-xs text-gray-500">
          séance{counts.completed !== 1 ? "s" : ""} complétée{counts.completed !== 1 ? "s" : ""} ce mois-ci
        </span>
      </div>
      <div>
        <span className="text-2xl font-semibold text-red-600 tabular-nums">{counts.skipped}</span>
        <span className="ml-2 text-xs text-gray-500">
          séance{counts.skipped !== 1 ? "s" : ""} non réalisée{counts.skipped !== 1 ? "s" : ""} ce mois-ci
        </span>
      </div>
    </div>
  );
}
