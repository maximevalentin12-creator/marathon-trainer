"use client";

import { useEffect, useState } from "react";

function currentMonthValue(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function MonthlyReportCard() {
  const [userId, setUserId] = useState<string | null | undefined>(undefined);
  const [month, setMonth] = useState(currentMonthValue());

  useEffect(() => {
    setUserId(localStorage.getItem("marathon_user_id"));
  }, []);

  if (userId === undefined) return null;

  if (!userId) {
    return (
      <p className="text-xs text-gray-500">
        <a href="/onboarding" className="underline">
          Complete onboarding
        </a>{" "}
        first to unlock monthly reports.
      </p>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="month"
        value={month}
        onChange={(e) => setMonth(e.target.value)}
        className="px-2 py-1.5 text-xs border border-gray-200 rounded focus:outline-none focus:border-gray-400 bg-white"
      />
      <a
        href={`/api/reports/monthly?userId=${userId}&month=${month}`}
        className="inline-block px-3 py-1.5 text-xs font-medium text-white bg-accent rounded hover:opacity-90 transition-opacity"
      >
        Download PDF →
      </a>
    </div>
  );
}
