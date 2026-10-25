"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";

// ─── Types ────────────────────────────────────────────────────────────────────

type Phase = "email" | "syncing" | "form" | "saving" | "done";

interface WeekRow {
  week: string;
  km: number;
  avgPaceSec: number | null;
  avgVo2max: number | null;
}

interface GarminSummary {
  weeks: WeekRow[];
  recentAvgKm: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parse "MM:SS" or "H:MM:SS" → seconds, or null if blank/invalid. */
function parseTime(s: string): number | null {
  if (!s.trim()) return null;
  const parts = s.trim().split(":").map(Number);
  if (parts.some((n) => isNaN(n) || n < 0)) return null;
  if (parts.length === 2) return parts[1] < 60 ? parts[0] * 60 + parts[1] : null;
  if (parts.length === 3)
    return parts[1] < 60 && parts[2] < 60
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : null;
  return null;
}

function fmtPace(sec: number | null): string {
  if (!sec) return "—";
  const m = Math.floor(sec / 60);
  const s = String(Math.round(sec % 60)).padStart(2, "0");
  return `${m}:${s}/km`;
}

function fmtWeek(iso: string): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-3">
      {children}
    </h2>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs text-gray-500">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

const inputCls =
  "w-full px-3 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:border-gray-400 bg-white";

// ─── Garmin summary display ───────────────────────────────────────────────────

function GarminSummaryPanel({ summary }: { summary: GarminSummary | null | "loading" }) {
  if (summary === "loading") {
    return <p className="text-xs text-gray-400">Loading…</p>;
  }
  if (!summary || summary.weeks.length === 0) {
    return (
      <p className="text-xs text-gray-400">
        No activity data found for your account. Make sure the Garmin sync ran
        with your user ID, or run it from the{" "}
        <a href="/" className="underline">
          dashboard
        </a>
        .
      </p>
    );
  }

  const maxKm = Math.max(...summary.weeks.map((w) => w.km), 1);
  const hasPace = summary.weeks.some((w) => w.avgPaceSec !== null);
  const hasVo2 = summary.weeks.some((w) => w.avgVo2max !== null);

  return (
    <div>
      <p className="text-xs text-gray-500 mb-4">
        Recent avg (4 weeks):{" "}
        <span className="font-medium text-gray-800">{summary.recentAvgKm} km/week</span>
      </p>

      {/* Column headers */}
      <div className="flex items-center gap-3 text-xs text-gray-400 mb-1.5 px-0.5">
        <span className="w-16 shrink-0">Week</span>
        <span className="w-24 shrink-0" />
        <span className="w-14 shrink-0">km</span>
        {hasPace && <span className="w-16 shrink-0">Pace</span>}
        {hasVo2 && <span>VO₂max</span>}
      </div>

      <div className="space-y-1.5">
        {summary.weeks.map((w) => (
          <div key={w.week} className="flex items-center gap-3 text-xs">
            <span className="w-16 text-gray-400 tabular-nums shrink-0">
              {fmtWeek(w.week)}
            </span>
            {/* Inline bar */}
            <div className="w-24 shrink-0 flex items-center">
              <div
                className="h-1.5 bg-accent rounded-full opacity-60"
                style={{ width: `${(w.km / maxKm) * 100}%` }}
              />
            </div>
            <span className="w-14 tabular-nums text-gray-700 shrink-0">
              {w.km} km
            </span>
            {hasPace && (
              <span className="w-16 tabular-nums text-gray-400 shrink-0">
                {fmtPace(w.avgPaceSec)}
              </span>
            )}
            {hasVo2 && w.avgVo2max !== null && (
              <span className="text-gray-400 tabular-nums">{w.avgVo2max}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>("email");
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [raceDate, setRaceDate] = useState("");
  const [runsPerWeek, setRunsPerWeek] = useState<1 | 2 | 3>(2);
  const [pb5k, setPb5k] = useState("");
  const [pb10k, setPb10k] = useState("");
  const [pbHalf, setPbHalf] = useState("");
  const [pbMarathon, setPbMarathon] = useState("");
  const [injuryHistory, setInjuryHistory] = useState("");

  // Garmin summary: null = not yet loaded, "loading" = in-flight, object = done
  const [summary, setSummary] = useState<GarminSummary | null | "loading">(null);

  const syncAbortRef = useRef<AbortController | null>(null);

  // ── Helpers ──────────────────────────────────────────────────────────────

  async function fetchSummary() {
    setSummary("loading");
    try {
      const r = await fetch("/api/onboarding/garmin-summary");
      const data = await r.json();
      setSummary(data.weeks ? data : null);
    } catch {
      setSummary(null);
    }
  }

  // ── Handlers ─────────────────────────────────────────────────────────────

  async function handleStart(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPhase("syncing");

    // 2. Trigger Garmin sync in background — abortable on skip
    const controller = new AbortController();
    syncAbortRef.current = controller;

    try {
      await fetch("/api/garmin/sync", { signal: controller.signal });
    } catch {
      // network error or aborted — either way fall through
    }

    if (!controller.signal.aborted) {
      await fetchSummary();
      setPhase("form");
    }
  }

  function handleSkipSync() {
    syncAbortRef.current?.abort();
    void fetchSummary(); // non-blocking; form shows "loading" briefly
    setPhase("form");
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (raceDate && new Date(raceDate) <= new Date()) {
      setError("Race date must be in the future.");
      return;
    }

    const pbFields = [
      ["5K", pb5k],
      ["10K", pb10k],
      ["Half-marathon", pbHalf],
      ["Marathon", pbMarathon],
    ] as const;
    for (const [label, val] of pbFields) {
      if (val && parseTime(val) === null) {
        setError(`Invalid time for ${label}. Use MM:SS or H:MM:SS.`);
        return;
      }
    }

    setError(null);
    setPhase("saving");

    const currentWeeklyKm =
      summary && summary !== "loading" ? summary.recentAvgKm : 30;

    const r = await fetch("/api/onboarding/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        raceDate: raceDate || null,
        runsPerWeek,
        pb5k: pb5k || null,
        pb10k: pb10k || null,
        pbHalf: pbHalf || null,
        pbMarathon: pbMarathon || null,
        injuryHistory: injuryHistory || null,
        currentWeeklyKm,
      }),
    });

    const data = await r.json();
    if (!r.ok || data.error) {
      setError(data.error ?? "Save failed.");
      setPhase("form");
      return;
    }

    setPhase("done");
  }

  // ── Render ───────────────────────────────────────────────────────────────

  if (phase === "done") {
    return (
      <main className="max-w-xl mx-auto px-4 py-12">
        <h1 className="text-xl font-semibold mb-2">All set.</h1>
        <p className="text-sm text-gray-500 mb-6">
          Your profile is saved. Generate your training plan from the dashboard.
        </p>
        <a
          href="/"
          className="inline-block px-4 py-2 text-sm font-medium text-white bg-gray-800 rounded hover:bg-gray-700"
        >
          Go to dashboard →
        </a>
      </main>
    );
  }

  if (phase === "email") {
    return (
      <main className="max-w-xl mx-auto px-4 py-12">
        <h1 className="text-xl font-semibold mb-1">Marathon Trainer</h1>
        <p className="text-sm text-gray-500 mb-8">
          On prépare ton profil d&apos;entraînement.
        </p>
        <form onSubmit={handleStart} className="space-y-4 max-w-sm">
          {error && <p className="text-xs text-red-500">{error}</p>}
          <button
            type="submit"
            className="px-4 py-2 text-sm font-medium text-white bg-gray-800 rounded hover:bg-gray-700 transition-colors"
          >
            Importer mon historique Garmin →
          </button>
        </form>
      </main>
    );
  }

  if (phase === "syncing") {
    return (
      <main className="max-w-xl mx-auto px-4 py-12">
        <h1 className="text-xl font-semibold mb-1">Marathon Trainer</h1>
        <p className="text-sm text-gray-500 mb-8">
          Importing your Garmin history…
        </p>
        <div className="border border-gray-200 rounded-lg p-8 text-center space-y-4">
          <div className="text-3xl animate-pulse select-none">↓</div>
          <p className="text-sm text-gray-600">
            Pulling up to 5 years of runs from Garmin Connect.
          </p>
          <p className="text-xs text-gray-400">This may take a minute.</p>
          <button
            onClick={handleSkipSync}
            className="text-xs text-gray-400 underline hover:text-gray-600 transition-colors"
          >
            Skip and fill in the form now
          </button>
        </div>
      </main>
    );
  }

  // "form" and "saving"
  const pbFields: Array<{
    label: string;
    value: string;
    setter: (v: string) => void;
    placeholder: string;
  }> = [
    { label: "5K", value: pb5k, setter: setPb5k, placeholder: "25:30" },
    { label: "10K", value: pb10k, setter: setPb10k, placeholder: "52:45" },
    { label: "Half-marathon", value: pbHalf, setter: setPbHalf, placeholder: "1:52:00" },
    { label: "Marathon", value: pbMarathon, setter: setPbMarathon, placeholder: "3:55:00" },
  ];

  return (
    <main className="max-w-xl mx-auto px-4 py-12 pb-24">
      <h1 className="text-xl font-semibold mb-1">Marathon Trainer</h1>
      <p className="text-sm text-gray-500 mb-8">
        Complete your profile to generate your training plan.
      </p>

      <form onSubmit={handleSave} className="space-y-8">
        {/* ── Personal records ── */}
        <section>
          <SectionLabel>Personal records (optional)</SectionLabel>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            {pbFields.map(({ label, value, setter, placeholder }) => (
              <Field key={label} label={label}>
                <input
                  type="text"
                  value={value}
                  onChange={(e) => setter(e.target.value)}
                  placeholder={placeholder}
                  className={inputCls + " font-mono"}
                />
              </Field>
            ))}
          </div>
          <p className="mt-2 text-xs text-gray-400">Format: MM:SS or H:MM:SS</p>
        </section>

        {/* ── Training rhythm ── */}
        <section>
          <SectionLabel>Training rhythm</SectionLabel>
          <div className="space-y-4">
            <Field label="Target race date (optional — training is continuous, not race-anchored)">
              <input
                type="date"
                value={raceDate}
                onChange={(e) => setRaceDate(e.target.value)}
                className="px-3 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:border-gray-400 bg-white"
              />
            </Field>

            <div>
              <span className="text-xs text-gray-500 block mb-2">
                Starting runs per week — you&apos;ll pick this again each week from the dashboard
              </span>
              <div className="flex gap-2">
                {([1, 2, 3] as const).map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setRunsPerWeek(n)}
                    className={`px-6 py-1.5 text-sm rounded border transition-colors ${
                      runsPerWeek === n
                        ? "bg-gray-800 text-white border-gray-800"
                        : "border-gray-200 text-gray-600 hover:border-gray-400"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ── Injury history ── */}
        <section>
          <SectionLabel>Injury history (optional)</SectionLabel>
          <textarea
            value={injuryHistory}
            onChange={(e) => setInjuryHistory(e.target.value)}
            placeholder="e.g. Left knee tendinitis 2024, shin splints 2023…"
            rows={3}
            className={inputCls + " resize-none"}
          />
        </section>

        {/* ── Garmin history ── */}
        <section>
          <SectionLabel>Your Garmin history — last 12 weeks</SectionLabel>
          <GarminSummaryPanel summary={summary} />
        </section>

        {error && (
          <p className="text-xs text-red-500 -mt-4">{error}</p>
        )}

        <button
          type="submit"
          disabled={phase === "saving"}
          className="w-full py-2.5 text-sm font-medium text-white bg-accent rounded hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {phase === "saving" ? "Saving…" : "Save & continue →"}
        </button>
      </form>
    </main>
  );
}
