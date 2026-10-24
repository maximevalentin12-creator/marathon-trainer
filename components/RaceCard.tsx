"use client";

import { useCallback, useEffect, useState } from "react";
import {
  daysUntilRace,
  parseIsoDate,
  raceModeSupported,
  RACE_MODE_MAX_DISTANCE_KM,
  RACE_PAIN_WARNING,
} from "@/lib/planner";

interface RaceRow {
  id: string;
  name: string;
  race_date: string;
  distance_km: number;
  /** Pain >= 3 reported in the 48 h before the race. */
  pain_warning?: boolean;
}

interface FormValues {
  name: string;
  raceDate: string;
  distanceKm: string;
}

const EMPTY_FORM: FormValues = { name: "", raceDate: "", distanceKm: "" };

/** Today's local calendar date, YYYY-MM-DD. */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtKm(km: number): string {
  return Number(km).toLocaleString("fr-FR", { maximumFractionDigits: 2 });
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

/** Dashboard card: the next race, its countdown, and add/edit/delete. */
export default function RaceCard() {
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
      <p className="text-xs text-gray-500">
        <a href="/onboarding" className="underline">
          Complete onboarding
        </a>{" "}
        first to add a race.
      </p>
    );
  }
  if (races === null) return <p className="text-xs text-gray-400">Chargement…</p>;

  const today = todayIso();
  const next = races.find((r) => r.race_date >= today) ?? null;
  // Shown when nothing is upcoming, so a race saved with a wrong (past) date doesn't silently vanish.
  const lastPast = [...races].reverse().find((r) => r.race_date < today) ?? null;

  function startEdit(race: RaceRow | null) {
    setError(null);
    setEditing(race ? race.id : "new");
    setForm(
      race
        ? { name: race.name, raceDate: race.race_date, distanceKm: String(race.distance_km) }
        : EMPTY_FORM
    );
  }

  async function save() {
    if (!userId || !editing) return;
    const distanceKm = Number(form.distanceKm.replace(",", "."));
    if (!form.raceDate) {
      setError("Choisis la date de la course.");
      return;
    }
    if (form.raceDate < today) {
      setError(`Le ${fmtDateFr(form.raceDate)} est déjà passé — vérifie la date (le mois en particulier).`);
      return;
    }
    if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
      setError("Distance invalide (ex. 21,1).");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch(editing === "new" ? "/api/races" : `/api/races/${editing}`, {
      method: editing === "new" ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, name: form.name, raceDate: form.raceDate, distanceKm }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Enregistrement impossible.");
      return;
    }
    setEditing(null);
    await load(userId);
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
    if (!res.ok) {
      setError(data.error ?? "Suppression impossible.");
      return;
    }
    await load(userId);
  }

  if (editing) {
    return (
      <div className="space-y-2">
        <input
          type="text"
          placeholder="Nom (ex. Semi-marathon d'Amsterdam)"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded focus:outline-none focus:border-gray-400 bg-white"
        />
        <div className="flex gap-2">
          <input
            type="date"
            value={form.raceDate}
            onChange={(e) => setForm({ ...form, raceDate: e.target.value })}
            className="px-2 py-1.5 text-xs border border-gray-200 rounded focus:outline-none focus:border-gray-400 bg-white"
          />
          <input
            type="text"
            inputMode="decimal"
            placeholder="Distance (km)"
            value={form.distanceKm}
            onChange={(e) => setForm({ ...form, distanceKm: e.target.value })}
            className="w-28 px-2 py-1.5 text-xs border border-gray-200 rounded focus:outline-none focus:border-gray-400 bg-white"
          />
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={save}
            className="px-3 py-1.5 text-xs font-medium text-white bg-accent rounded hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            Enregistrer
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setEditing(null)}
            className="px-3 py-1.5 text-xs font-medium border border-gray-200 text-gray-600 rounded hover:border-gray-400 transition-colors"
          >
            Annuler
          </button>
        </div>
      </div>
    );
  }

  if (!next) {
    return (
      <div>
        <p className="text-xs text-gray-500 mb-3">Aucune course à venir.</p>
        {lastPast && (
          <div className="mb-3 rounded-md border border-gray-200 px-2.5 py-1.5">
            <p className="text-xs text-gray-600">
              Dernière course enregistrée : {lastPast.name} · {fmtKm(lastPast.distance_km)} km ·{" "}
              <span className="font-medium">{fmtDateFr(lastPast.race_date)}</span> (passée)
            </p>
            <div className="flex items-center gap-3 mt-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => startEdit(lastPast)}
                className="text-xs text-gray-500 underline hover:text-gray-700 disabled:opacity-50 transition-colors"
              >
                Corriger la date
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => remove(lastPast)}
                className="text-xs text-gray-400 underline hover:text-red-600 disabled:opacity-50 transition-colors"
              >
                Supprimer
              </button>
            </div>
          </div>
        )}
        {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
        <button
          type="button"
          onClick={() => startEdit(null)}
          className="px-3 py-1.5 text-xs font-medium text-white bg-accent rounded hover:opacity-90 transition-opacity"
        >
          Ajouter une course
        </button>
      </div>
    );
  }

  const days = daysUntilRace(parseIsoDate(next.race_date), parseIsoDate(today));
  const supported = raceModeSupported(Number(next.distance_km));

  return (
    <div>
      <p className="text-sm text-gray-800 tabular-nums">
        <span className="font-semibold">{fmtCountdown(days)}</span> · {next.name} · {fmtKm(next.distance_km)} km
      </p>
      <p className="text-[11px] text-gray-500 mt-0.5 capitalize">{fmtDateFr(next.race_date)}</p>
      {next.pain_warning && (
        <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">
          {RACE_PAIN_WARNING}
        </p>
      )}
      {supported ? (
        <p className="text-[11px] text-gray-400 mt-1">
          Le plan s&apos;adapte aux semaines autour de la course à la prochaine génération de la semaine.
        </p>
      ) : (
        <p className="text-[11px] text-amber-600 mt-1">
          Mode course non activé : au-delà de {fmtKm(RACE_MODE_MAX_DISTANCE_KM)} km, la course est enregistrée mais le
          plan reste normal.
        </p>
      )}
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
      <div className="flex items-center gap-3 mt-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => startEdit(next)}
          className="px-3 py-1.5 text-xs font-medium border border-gray-200 text-gray-600 rounded hover:border-gray-400 transition-colors"
        >
          Modifier
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => remove(next)}
          className="text-xs text-gray-400 underline hover:text-red-600 disabled:opacity-50 transition-colors"
        >
          Supprimer
        </button>
      </div>
    </div>
  );
}
