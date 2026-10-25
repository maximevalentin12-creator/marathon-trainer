"use client";

import { useState } from "react";

function currentMonthValue(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function MonthlyReportCard() {
  const [month, setMonth] = useState(currentMonthValue());

  return (
    <div className="flex items-center gap-2">
      <input
        type="month"
        value={month}
        onChange={(e) => setMonth(e.target.value)}
        className="px-2 py-1.5 text-xs border border-gray-200 rounded focus:outline-none focus:border-gray-400 bg-white"
      />
      <a
        href={`/api/reports/monthly?month=${month}`}
        className="inline-block px-3 py-1.5 text-xs font-medium text-white bg-accent rounded hover:opacity-90 transition-opacity"
      >
        Télécharger le PDF →
      </a>
    </div>
  );
}
