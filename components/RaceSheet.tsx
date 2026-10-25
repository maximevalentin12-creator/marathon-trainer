"use client";

import { useCallback, useEffect, useState } from "react";
import { daysUntilRace, parseIsoDate, RACE_PAIN_WARNING } from "@/lib/planner";

interface RaceRow {
  id: string;
  name: string;
  race_date: string;
  distance_km: number;
  kind?: "goal" | "tune_up";
  parent_race_id?: string | null;
  bib_status?: "confirmed" | "pending" | "solo_test";
  target_time_s?: number | null;
  result_time_s?: number | null;
  /** Pain >= 3 reported in the 48 h before the race. */
  pain_warning?: boolean;
}

type DistancePreset = "5" | "10" | "21.1" | "42.195" | "custom";

interface FormValues {
  name: string;
  raceDate: string;
  preset: DistancePreset;
  customKm: string;
  kind: "goal" | "tune_up";
  parentRaceId: string;
  bibStatus: "confirmed" | "pending" | "solo_test";
  targetTime: string;
  resultTime: string;
}

const EMPTY_FORM: FormValues = {
  name: "",
  raceDate: "",
  preset: "42.195",
  customKm: "",
  kind: "goal",
  parentRaceId: "",
  bibStatus: "pending",
  targetTime: "",
  resultTime: "",
};

const PRESETS: Array<{ value: DistancePreset; label: string }> = [
  { value: "5", label: "5 km" },
  { value: "10", label: "10 km" },
  { value: "21.1", label: "Semi" },
  { value: "42.195", label: "Marathon" },
  { value: "custom", label: "Autre" },
];

const BIB_LABEL: Record<NonNullable<RaceRow["bib_status"]>, string> = {
  confirmed: "Dossard confirmé",
  pending: "Inscription en attente",
  solo_test: "Test en solo",
};

/** Today's local calendar date, YYYY-MM-DD. */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtKm(km: number): string {
  return Number(km).toLocaleString("fr-FR", { maximumFractionDigits: 3 });
}

/** "dimanche 18 octobre 2026" — spelled out, so a wrong month is obvious. */
function fmtDateFr(iso: string): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function fmtCountdown(days: number): string {
  return days === 0 ? "Jour J" : `J-${days}`;
}

/** 6872 → "1:54:32". */
function fmtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** "3:45:00", "45:30" or "" → seconds, null when empty, NaN when malformed. */
function parseTime(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(":").map((p) => Number(p));
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !Number.isInteger(p) || p < 0)) return NaN;
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  if (m > 59 || s > 59) return NaN;
  const total = h * 3600 + m * 60 + s;
  return total > 0 ? total : NaN;
}

function presetOf(km: number): { preset: DistancePreset; customKm: string } {
  for (const p of PRESETS) {
    if (p.value !== "custom" && Math.abs(Number(p.value) - Number(km)) < 0.01) return { preset: p.value, customKm: "" };
  }
  return { preset: "custom", customKm: String(km).replace(".", ",") };
}

const FIELD =
  "w-full px-3 py-2.5 min-h-[44px] text-base border border-gray-200 rounded-lg bg-white focus:outline-none focus:border-gray-400";
const CHIP_BASE = "px-3.5 py-2 min-h-[44px] text-sm rounded-lg border transition-colors";
const chip = (on: boolean) =>
  `${CHIP_BASE} ${on ? "bg-gray-800 text-white border-gray-800" : "border-gray-200 text-gray-700 bg-white hover:border-gray-400"}`;

/** The user's races: the goal with its tune-ups underneath, past races to correct, and the add/edit sheet. */
export default function RaceSheet({ onChanged }: { onChanged?: () => void }) {
  const [userId, setUserId] = useState<string | null | undefined>(undefined);
  const [races, setRaces] = useState<RaceRow[] | null>(null);
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [form, setForm] = useState<FormValues>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUserId(localStorage.getItem("marathon_user_id"));
  }, []);

  const load = useCallback(async (uid: string) => {
    const res = await fetch(`/api/races?userId=${uid}`);
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Impossible de charger les courses.");
      setRaces([]);
      return;
    }
    setRaces(data.races);
  }, []);

  useEffect(() => {
    if (userId) load(userId);
  }, [userId, load]);

  if (userId === undefined) return null;
  if (!userId) {
    return (
      <p className="text-sm text-gray-600">
        <a href="/onboarding" className="underline">
          Termine d&apos;abord la prise en main
        </a>{" "}
        pour ajouter une course.
      </p>
    );
  }
  if (races === null) return <p className="text-sm text-gray-500">Chargement…</p>;

  const today = todayIso();
  const upcoming = races.filter((r) => r.race_date >= today);
  const past = races.filter((r) => r.race_date < today).reverse();
  const goals = upcoming.filter((r) => (r.kind ?? "goal") === "goal");
  const tuneUpsOf = (goalId: string) => upcoming.filter((r) => r.kind === "tune_up" && r.parent_race_id === goalId);
  const orphans = upcoming.filter((r) => r.kind === "tune_up" && !goals.some((g) => g.id === r.parent_race_id));
  const editingRace = editing && editing !== "new" ? races.find((r) => r.id === editing) ?? null : null;
  const editingPast = !!editingRace && editingRace.race_date < today;

  function startEdit(race: RaceRow | null) {
    setError(null);
    setEditing(race ? race.id : "new");
    if (!race) {
      setForm({ ...EMPTY_FORM, parentRaceId: goals[0]?.id ?? "" });
      return;
    }
    setForm({
      name: race.name,
      raceDate: race.race_date,
      ...presetOf(race.distance_km),
      kind: race.kind ?? "goal",
      parentRaceId: race.parent_race_id ?? "",
      bibStatus: race.bib_status ?? "pending",
      targetTime: race.target_time_s ? fmtTime(race.target_time_s) : "",
      resultTime: race.result_time_s ? fmtTime(race.result_time_s) : "",
    });
  }

  async function save() {
    if (!userId || !editing) return;
    const distanceKm = form.preset === "custom" ? Number(form.customKm.replace(",", ".")) : Number(form.preset);
    if (!form.name.trim()) return setError("Donne un nom à la course.");
    if (!form.raceDate) return setError("Choisis la date de la course.");
    // New and upcoming races are in the future; a past race is only corrected.
    if (!editingPast && form.raceDate < today) {
      return setError(`Le ${fmtDateFr(form.raceDate)} est déjà passé — vérifie la date (le mois en particulier).`);
    }
    if (!Number.isFinite(distanceKm) || distanceKm <= 0) return setError("Distance invalide (ex. 21,1).");
    if (form.kind === "tune_up" && !form.parentRaceId) {
      return setError(goals.length === 0 ? "Ajoute d'abord une course objectif pour y rattacher cette course." : "Choisis la course objectif.");
    }
    const target = parseTime(form.targetTime);
    const result = parseTime(form.resultTime);
    if (Number.isNaN(target)) return setError("Temps visé invalide (ex. 3:45:00).");
    if (Number.isNaN(result)) return setError("Temps de course invalide (ex. 1:54:32).");

    setBusy(true);
    setError(null);
    const res = await fetch(editing === "new" ? "/api/races" : `/api/races/${editing}`, {
      method: editing === "new" ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        name: form.name,
        raceDate: form.raceDate,
        distanceKm,
        kind: form.kind,
        parentRaceId: form.kind === "tune_up" ? form.parentRaceId : null,
        bibStatus: form.bibStatus,
        targetTimeS: target,
        ...(editingPast || editingRace?.result_time_s ? { resultTimeS: result } : {}),
      }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) return setError(data.error ?? "Enregistrement impossible.");
    setEditing(null);
    await load(userId);
    onChanged?.();
  }

  async function remove(race: RaceRow) {
    if (!userId || !confirm(`Supprimer « ${race.name} » ?`)) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/races/${race.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) return setError(data.error ?? "Suppression impossible.");
    await load(userId);
    onChanged?.();
  }

  function RaceItem({ race, nested }: { race: RaceRow; nested?: boolean }) {
    const days = daysUntilRace(parseIsoDate(race.race_date), parseIsoDate(today));
    return (
      <div className={`bg-white border border-gray-200 rounded-lg px-3 py-3 ${nested ? "ml-4 border-l-4 border-l-gray-300" : ""}`}>
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-medium text-gray-900 min-w-0">{race.name}</p>
          <p className="text-sm font-semibold tabular-nums text-gray-900 shrink-0">{fmtCountdown(days)}</p>
        </div>
        <p className="text-xs text-gray-500 mt-0.5">
          {fmtKm(race.distance_km)} km · <span className="capitalize">{fmtDateFr(race.race_date)}</span>
        </p>
        <p className="text-xs text-gray-500 mt-0.5">
          {BIB_LABEL[race.bib_status ?? "confirmed"]}
          {race.target_time_s ? ` · Objectif ${fmtTime(race.target_time_s)}` : ""}
          {race.kind === "tune_up" ? " · Course de préparation" : ""}
        </p>
        {race.pain_warning && (
          <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{RACE_PAIN_WARNING}</p>
        )}
        <div className="flex items-center gap-4 mt-2">
          <button type="button" disabled={busy} onClick={() => startEdit(race)} className="min-h-[36px] text-sm text-gray-700 underline">
            Modifier
          </button>
          <button type="button" disabled={busy} onClick={() => remove(race)} className="min-h-[36px] text-sm text-gray-400 underline hover:text-red-600">
            Supprimer
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && !editing && <p className="text-sm text-red-600">{error}</p>}

      {goals.length === 0 && orphans.length === 0 && <p className="text-sm text-gray-600">Aucune course à venir.</p>}

      {goals.map((g) => (
        <div key={g.id} className="space-y-2">
          <RaceItem race={g} />
          {tuneUpsOf(g.id).map((t) => (
            <RaceItem key={t.id} race={t} nested />
          ))}
        </div>
      ))}

      {orphans.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-gray-500 px-1">Courses de préparation sans objectif</p>
          {orphans.map((t) => (
            <RaceItem key={t.id} race={t} />
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => startEdit(null)}
        className="w-full md:w-auto px-4 py-3 min-h-[44px] text-sm font-medium text-white bg-accent rounded-lg hover:opacity-90 transition-opacity"
      >
        Ajouter une course
      </button>

      {past.length > 0 && (
        <details className="pt-2">
          <summary className="text-sm text-gray-600 cursor-pointer min-h-[36px] flex items-center">
            Courses passées ({past.length})
          </summary>
          <div className="space-y-2 mt-2">
            {past.map((r) => (
              <div key={r.id} className="bg-white border border-gray-200 rounded-lg px-3 py-2.5">
                <p className="text-sm text-gray-800">
                  {r.name} · {fmtKm(r.distance_km)} km
                  {r.result_time_s ? ` · ${fmtTime(r.result_time_s)}` : ""}
                </p>
                <p className="text-xs text-gray-500 capitalize">{fmtDateFr(r.race_date)}</p>
                <div className="flex items-center gap-4 mt-1">
                  <button type="button" disabled={busy} onClick={() => startEdit(r)} className="min-h-[36px] text-sm text-gray-700 underline">
                    Corriger
                  </button>
                  <button type="button" disabled={busy} onClick={() => remove(r)} className="min-h-[36px] text-sm text-gray-400 underline hover:text-red-600">
                    Supprimer
                  </button>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/40" role="dialog" aria-modal="true">
          <div className="w-full md:max-w-md max-h-[92vh] overflow-y-auto bg-white rounded-t-2xl md:rounded-2xl p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-semibold">
                {editing === "new" ? "Nouvelle course" : editingPast ? "Corriger la course" : "Modifier la course"}
              </h3>
              <button type="button" onClick={() => setEditing(null)} aria-label="Fermer" className="w-11 h-11 -mr-2 text-2xl text-gray-400">
                ×
              </button>
            </div>

            <div className="space-y-4">
              <label className="block">
                <span className="text-xs text-gray-600 block mb-1">Nom</span>
                <input
                  type="text"
                  placeholder="Ex. Marathon de Paris"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className={FIELD}
                />
              </label>

              <label className="block">
                <span className="text-xs text-gray-600 block mb-1">Date</span>
                <input
                  type="date"
                  min={editingPast ? undefined : today}
                  value={form.raceDate}
                  onChange={(e) => setForm({ ...form, raceDate: e.target.value })}
                  className={FIELD}
                />
              </label>

              <div>
                <span className="text-xs text-gray-600 block mb-1">Distance</span>
                <div className="flex gap-2 flex-wrap">
                  {PRESETS.map((p) => (
                    <button key={p.value} type="button" onClick={() => setForm({ ...form, preset: p.value })} className={chip(form.preset === p.value)}>
                      {p.label}
                    </button>
                  ))}
                </div>
                {form.preset === "custom" && (
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="Distance en km (ex. 15)"
                    value={form.customKm}
                    onChange={(e) => setForm({ ...form, customKm: e.target.value })}
                    className={`${FIELD} mt-2`}
                  />
                )}
              </div>

              <div>
                <span className="text-xs text-gray-600 block mb-1">Type de course</span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setForm({ ...form, kind: "goal", bibStatus: form.bibStatus })} className={chip(form.kind === "goal")}>
                    Course objectif
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, kind: "tune_up", parentRaceId: form.parentRaceId || goals[0]?.id || "" })}
                    className={chip(form.kind === "tune_up")}
                  >
                    Course de préparation
                  </button>
                </div>
              </div>

              {form.kind === "tune_up" && (
                <label className="block">
                  <span className="text-xs text-gray-600 block mb-1">Elle prépare quelle course objectif ?</span>
                  <select
                    value={form.parentRaceId}
                    onChange={(e) => setForm({ ...form, parentRaceId: e.target.value })}
                    className={FIELD}
                  >
                    <option value="">Choisir…</option>
                    {goals.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <div>
                <span className="text-xs text-gray-600 block mb-1">Inscription</span>
                <div className="flex gap-2 flex-wrap">
                  {(["confirmed", "pending", "solo_test"] as const).map((b) => (
                    <button key={b} type="button" onClick={() => setForm({ ...form, bibStatus: b })} className={chip(form.bibStatus === b)}>
                      {b === "confirmed" ? "Inscrit" : b === "pending" ? "En attente" : "Test en solo"}
                    </button>
                  ))}
                </div>
                {form.bibStatus === "solo_test" && (
                  <p className="text-xs text-gray-500 mt-1">Tu le cours seul(e), sans dossard : le plan le traite comme un test chronométré.</p>
                )}
              </div>

              <label className="block">
                <span className="text-xs text-gray-600 block mb-1">Temps visé (facultatif)</span>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="Ex. 3:45:00"
                  value={form.targetTime}
                  onChange={(e) => setForm({ ...form, targetTime: e.target.value })}
                  className={FIELD}
                />
              </label>

              {(editingPast || editingRace?.result_time_s) && (
                <label className="block">
                  <span className="text-xs text-gray-600 block mb-1">Temps réalisé (sert à calculer tes allures)</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="Ex. 1:54:32"
                    value={form.resultTime}
                    onChange={(e) => setForm({ ...form, resultTime: e.target.value })}
                    className={FIELD}
                  />
                </label>
              )}

              {error && <p className="text-sm text-red-600">{error}</p>}

              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={save}
                  className="flex-1 px-4 py-3 min-h-[44px] text-sm font-medium text-white bg-accent rounded-lg hover:opacity-90 disabled:opacity-50 transition-opacity"
                >
                  {busy ? "Enregistrement…" : "Enregistrer"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setEditing(null)}
                  className="px-4 py-3 min-h-[44px] text-sm font-medium border border-gray-200 text-gray-700 rounded-lg hover:border-gray-400"
                >
                  Annuler
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
