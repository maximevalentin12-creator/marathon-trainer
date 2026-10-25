"use client";

import { useState, useEffect } from "react";

type Phase = "form" | "saving" | "done" | "no-user";

// ─── Score buttons ─────────────────────────────────────────────────────────────

function ScoreRow({
  label,
  hint,
  value,
  min = 1,
  max = 5,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
}) {
  const scores = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  return (
    <div>
      <div className="flex justify-between items-baseline mb-2">
        <span className="text-xs text-gray-600">{label}</span>
        {hint && <span className="text-xs text-gray-400">{hint}</span>}
      </div>
      <div className="flex gap-1.5">
        {scores.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onChange(s)}
            aria-pressed={value === s}
            className={`h-8 flex-1 text-xs rounded border transition-colors ${
              value === s
                ? "bg-gray-800 text-white border-gray-800"
                : "border-gray-200 text-gray-500 hover:border-gray-400"
            }`}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const textareaCls =
  "w-full px-3 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:border-gray-400 bg-white resize-none";

export default function LogPage() {
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(null);

  const today = new Date().toISOString().split("T")[0];
  const [entryDate, setEntryDate] = useState(today);
  const [mood, setMood] = useState(3);
  const [energy, setEnergy] = useState(3);
  const [pain, setPain] = useState(0);
  const [injuryNotes, setInjuryNotes] = useState("");
  const [strainNotes, setStrainNotes] = useState("");
  const [overallNotes, setOverallNotes] = useState("");

  function resetForm() {
    setMood(3);
    setEnergy(3);
    setPain(0);
    setInjuryNotes("");
    setStrainNotes("");
    setOverallNotes("");
    setEntryDate(new Date().toISOString().split("T")[0]);
    setError(null);
    setPhase("form");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPhase("saving");

    const r = await fetch("/api/log/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entryDate,
        moodScore: mood,
        energyScore: energy,
        painScore: pain,
        injuryNotes: injuryNotes || null,
        strainNotes: strainNotes || null,
        overallNotes: overallNotes || null,
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

  // ── Render ──────────────────────────────────────────────────────────────────

  if (phase === "no-user") {
    return (
      <main className="max-w-xl mx-auto px-4 py-12">
        <p className="text-sm text-gray-500">
          No profile found.{" "}
          <a href="/onboarding" className="underline">
            Complete onboarding first →
          </a>
        </p>
      </main>
    );
  }

  if (phase === "done") {
    return (
      <main className="max-w-xl mx-auto px-4 py-12">
        <p className="text-sm text-gray-800 mb-4">Entry saved.</p>
        <div className="flex gap-4">
          <button onClick={resetForm} className="text-xs text-gray-500 underline">
            Log another run
          </button>
          <a href="/trends" className="text-xs text-gray-500 underline">
            See trends →
          </a>
          <a href="/" className="text-xs text-gray-500 underline">
            Dashboard
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-xl mx-auto px-4 py-12 pb-24">
      <a href="/" className="text-xs text-gray-400 hover:text-gray-600 block mb-6">
        ← Dashboard
      </a>
      <h1 className="text-xl font-semibold mb-8">Post-run log</h1>

      <form onSubmit={handleSubmit} className="space-y-8">
        {/* Date */}
        <div>
          <label className="text-xs text-gray-500 block mb-1">Date</label>
          <input
            type="date"
            value={entryDate}
            onChange={(e) => setEntryDate(e.target.value)}
            className="px-3 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:border-gray-400 bg-white"
          />
        </div>

        {/* Scores */}
        <section className="space-y-5">
          <h2 className="text-xs font-medium uppercase tracking-wide text-gray-400">
            How did it feel?
          </h2>
          <ScoreRow
            label="Mood"
            hint="1 = rough · 5 = great"
            value={mood}
            min={1}
            max={5}
            onChange={setMood}
          />
          <ScoreRow
            label="Energy"
            hint="1 = exhausted · 5 = full of energy"
            value={energy}
            min={1}
            max={5}
            onChange={setEnergy}
          />
          <ScoreRow
            label="Pain / discomfort"
            hint="0 = none · 5 = severe"
            value={pain}
            min={0}
            max={5}
            onChange={setPain}
          />
        </section>

        {/* Notes */}
        <section className="space-y-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-gray-400">
            Notes (optional)
          </h2>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Injury</label>
            <textarea
              rows={2}
              value={injuryNotes}
              onChange={(e) => setInjuryNotes(e.target.value)}
              placeholder="Any pain or injury?"
              className={textareaCls}
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">
              Muscle strain / tension
            </label>
            <textarea
              rows={2}
              value={strainNotes}
              onChange={(e) => setStrainNotes(e.target.value)}
              placeholder="Tight calves, heavy legs…"
              className={textareaCls}
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">General</label>
            <textarea
              rows={2}
              value={overallNotes}
              onChange={(e) => setOverallNotes(e.target.value)}
              placeholder="Anything else…"
              className={textareaCls}
            />
          </div>
        </section>

        {error && <p className="text-xs text-red-500">{error}</p>}

        <button
          type="submit"
          disabled={phase === "saving"}
          className="w-full py-2.5 text-sm font-medium text-white bg-accent rounded hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {phase === "saving" ? "Saving…" : "Save entry →"}
        </button>
      </form>
    </main>
  );
}
