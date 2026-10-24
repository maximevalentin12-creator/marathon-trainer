"use client";

import { useState, useEffect } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface WeekData {
  week: string;
  avgPain: number | null;
  avgEnergy: number | null;
  avgMood: number | null;
  count: number;
}

// ─── SVG chart constants ──────────────────────────────────────────────────────

const VB_W = 520;
const VB_H = 180;
const PAD = { top: 16, right: 16, bottom: 36, left: 28 };
const IW = VB_W - PAD.left - PAD.right; // inner width
const IH = VB_H - PAD.top - PAD.bottom; // inner height
const Y_MAX = 5; // scores top out at 5

function xOf(i: number, n: number): number {
  return n <= 1 ? PAD.left + IW / 2 : PAD.left + (i / (n - 1)) * IW;
}

function yOf(v: number): number {
  return PAD.top + ((Y_MAX - v) / Y_MAX) * IH;
}

/** Build an SVG path string with M/L commands, lifting the pen at null values. */
function buildPath(pts: Array<{ x: number; y: number | null }>): string {
  const cmds: string[] = [];
  let penDown = false;
  for (const { x, y } of pts) {
    if (y === null) {
      penDown = false;
      continue;
    }
    cmds.push(`${penDown ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`);
    penDown = true;
  }
  return cmds.join(" ");
}

function fmtWeek(iso: string): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// ─── Series config ────────────────────────────────────────────────────────────

interface SeriesPoint {
  x: number;
  pain: number | null;
  energy: number | null;
  mood: number | null;
}

const SERIES: Array<{
  key: keyof Omit<SeriesPoint, "x">;
  label: string;
  color: string;
}> = [
  { key: "pain",   label: "Pain",   color: "#dc2626" },
  { key: "energy", label: "Energy", color: "#2563eb" },
  { key: "mood",   label: "Mood",   color: "#4a7c3f" },
];

// ─── Chart ────────────────────────────────────────────────────────────────────

function TrendChart({ data }: { data: WeekData[] }) {
  if (data.length === 0) {
    return (
      <div className="border border-gray-100 rounded-lg h-44 flex items-center justify-center">
        <p className="text-xs text-gray-400">No entries yet — log your first run.</p>
      </div>
    );
  }

  const n = data.length;

  const points: SeriesPoint[] = data.map((d, i) => ({
    x: xOf(i, n),
    pain: d.avgPain,
    energy: d.avgEnergy,
    mood: d.avgMood,
  }));

  // Which x-axis ticks to label (first, last, and ~every n/4 steps)
  const step = Math.max(1, Math.floor(n / 4));
  const labelIdx = new Set<number>([0, n - 1]);
  for (let i = step; i < n - 1; i += step) labelIdx.add(i);

  return (
    <svg
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      className="w-full"
      role="img"
      aria-label="Pain, energy and mood trend over the past weeks"
    >
      {/* Horizontal grid lines */}
      {[0, 1, 2, 3, 4, 5].map((v) => (
        <line
          key={v}
          x1={PAD.left}  y1={yOf(v)}
          x2={PAD.left + IW} y2={yOf(v)}
          stroke={v === 0 ? "#d1d5db" : "#f3f4f6"}
          strokeWidth="1"
        />
      ))}

      {/* Y-axis labels */}
      {[0, 1, 2, 3, 4, 5].map((v) => (
        <text
          key={v}
          x={PAD.left - 5}
          y={yOf(v) + 4}
          textAnchor="end"
          fontSize="10"
          fill="#d1d5db"
        >
          {v}
        </text>
      ))}

      {/* X-axis week labels */}
      {data.map((d, i) =>
        labelIdx.has(i) ? (
          <text
            key={d.week}
            x={xOf(i, n)}
            y={VB_H - 6}
            textAnchor="middle"
            fontSize="9"
            fill="#d1d5db"
          >
            {fmtWeek(d.week)}
          </text>
        ) : null
      )}

      {/* Series: line + dots */}
      {SERIES.map(({ key, color }) => {
        const pts = points.map((p) => {
          const v = p[key];
          return { x: p.x, y: v !== null ? yOf(v) : null };
        });

        return (
          <g key={key}>
            <path
              d={buildPath(pts)}
              fill="none"
              stroke={color}
              strokeWidth="1.75"
              strokeOpacity="0.75"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {pts
              .filter((p): p is { x: number; y: number } => p.y !== null)
              .map((p, i) => (
                <circle
                  key={i}
                  cx={p.x}
                  cy={p.y}
                  r={3}
                  fill={color}
                  fillOpacity="0.85"
                />
              ))}
          </g>
        );
      })}
    </svg>
  );
}

// ─── Legend ───────────────────────────────────────────────────────────────────

function Legend() {
  return (
    <div className="flex gap-5 mt-2">
      {SERIES.map(({ label, color }) => (
        <div key={label} className="flex items-center gap-1.5 text-xs text-gray-500">
          <svg width="16" height="3" aria-hidden>
            <line x1="0" y1="1.5" x2="16" y2="1.5" stroke={color} strokeWidth="2" strokeOpacity="0.75" />
          </svg>
          {label}
        </div>
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function fmtScore(v: number | null): string {
  return v !== null ? v.toFixed(1) : "—";
}

export default function TrendsPage() {
  const [data, setData] = useState<WeekData[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const id = localStorage.getItem("marathon_user_id");
    if (!id) {
      setData([]);
      return;
    }

    fetch(`/api/trends/subjective?userId=${id}`)
      .then((r) => r.json())
      .then((d) => setData(d.weeks ?? []))
      .catch(() => setError("Failed to load trends."));
  }, []);

  // Reverse copy for the table (most recent first)
  const tableRows = data ? [...data].reverse() : [];

  return (
    <main className="max-w-xl mx-auto px-4 py-12 pb-16">
      <a href="/" className="text-xs text-gray-400 hover:text-gray-600 block mb-6">
        ← Dashboard
      </a>
      <h1 className="text-xl font-semibold mb-1">Pain &amp; fatigue trend</h1>
      <p className="text-sm text-gray-500 mb-6">Last 12 weeks · Weekly averages</p>

      {data === null ? (
        <p className="text-xs text-gray-400">Loading…</p>
      ) : (
        <>
          <TrendChart data={data} />
          {data.length > 0 && <Legend />}

          {data.length > 0 && (
            <section className="mt-8">
              <h2 className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-3">
                Weekly detail
              </h2>
              {/* Header */}
              <div className="flex text-xs text-gray-400 gap-2 pb-1.5 border-b border-gray-100">
                <span className="w-16 shrink-0">Week</span>
                <span className="w-12 text-right shrink-0 tabular-nums">Pain</span>
                <span className="w-12 text-right shrink-0 tabular-nums">Energy</span>
                <span className="w-12 text-right shrink-0 tabular-nums">Mood</span>
                <span className="flex-1 text-right tabular-nums">n</span>
              </div>
              <div className="space-y-1 mt-1.5">
                {tableRows.map((d) => (
                  <div key={d.week} className="flex text-xs gap-2 items-center">
                    <span className="w-16 shrink-0 text-gray-400">{fmtWeek(d.week)}</span>
                    <span
                      className="w-12 text-right shrink-0 tabular-nums font-medium"
                      style={{
                        color:
                          d.avgPain === null
                            ? "#d1d5db"
                            : d.avgPain >= 3
                            ? "#dc2626"
                            : d.avgPain >= 1
                            ? "#d97706"
                            : "#6b7280",
                      }}
                    >
                      {fmtScore(d.avgPain)}
                    </span>
                    <span className="w-12 text-right shrink-0 tabular-nums text-gray-600">
                      {fmtScore(d.avgEnergy)}
                    </span>
                    <span className="w-12 text-right shrink-0 tabular-nums text-gray-600">
                      {fmtScore(d.avgMood)}
                    </span>
                    <span className="flex-1 text-right tabular-nums text-gray-300">
                      {d.count}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <div className="mt-8">
            <a
              href="/log"
              className="inline-block px-3 py-1.5 text-xs font-medium text-white bg-accent rounded hover:opacity-90 transition-opacity"
            >
              Log a run →
            </a>
          </div>
        </>
      )}

      {error && <p className="text-xs text-red-500 mt-4">{error}</p>}
    </main>
  );
}
