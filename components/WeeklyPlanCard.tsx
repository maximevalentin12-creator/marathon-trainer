"use client";

import { useState, useEffect, useCallback } from "react";
import {
  DAY_CODES,
  DAY_LABELS_FR,
  NON_IMPACT_MACHINES,
  MACHINE_LABEL_FR,
  RACE_PAIN_WARNING,
  type DayCode,
  type EffortZone,
  type EffortZoneId,
  type NonImpactMachine,
} from "@/lib/planner";
import { wearLevel, WEAR_DOT_CLASS } from "@/lib/shoes";
import CompletionCartouche from "@/components/CompletionCartouche";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SessionStepRow {
  label: string;
  durationMinutes: number | null;
  description: string;
  zoneLabel: string;
  paceHint?: string;
  heartRateHint?: string;
}

interface ActualStats {
  distanceKm: number | null;
  durationMinutes: number | null;
  durationSeconds: number | null;
  avgPaceSecPerKm: number | null;
  avgHeartRate: number | null;
}

interface SessionRow {
  id: string;
  planned_date: string;
  session_type: "easy" | "long" | "threshold" | "vo2max" | "rest" | "race";
  session_label: string | null;
  variant: string | null;
  modality: "running" | "non_impact";
  indoor: boolean;
  incline_percent: number | null;
  machine: NonImpactMachine | null;
  steps: SessionStepRow[] | null;
  zone_summary: string | null;
  downgrade_reason: string | null;
  strides_added: boolean;
  target_distance_km: number | null;
  target_duration_minutes: number | null;
  target_pace_sec_per_km: number | null;
  why_note: string | null;
  completed: boolean;
  skipped: boolean;
  actual: ActualStats | null;
  completion_score: number | null;
  completion_note: string | null;
  completion_analysis: string[] | null;
  manual_day_override: boolean;
  shoe_id: string | null;
  /** Only set right after a regeneration whose available days no longer fit a previous manual override. */
  day_override_dropped?: boolean;
  /** Race session with pain >= 3 reported in the 48 h before it (the race itself is never downgraded). */
  pain_warning?: boolean;
}

interface ShoeOption {
  id: string;
  name: string;
  retired: boolean;
  total_km: number;
}

interface WeekSetup {
  runsPerWeek: number;
  indoorRuns: number;
  nonImpactSessions: number;
  nonImpactMachines: NonImpactMachine[];
  availableDays: DayCode[];
}

interface WeekResponse {
  weekStart: string;
  setup: WeekSetup | null;
  suggestedRunsPerWeek: 1 | 2 | 3;
  /** The athlete's HR zones (from /profil's FC max / FC repos). */
  zones: Record<EffortZoneId, EffortZone>;
  sessions: SessionRow[];
}

type Phase = "loading" | "setup" | "saving" | "ready" | "no-user";

/** Broadcast whenever a session's completed/skipped state may have changed, so the dashboard's monthly counter can refresh. */
const SESSIONS_CHANGED_EVENT = "marathon:sessions-changed";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDay(iso: string): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function fmtPace(sec: number | null): string {
  if (!sec) return "—";
  const m = Math.floor(sec / 60);
  const s = String(Math.round(sec % 60)).padStart(2, "0");
  return `${m}:${s}/km`;
}

/** Which of the week's days (0=Mon..6=Sun) an ISO date falls on, given that week's Monday. */
function dayCodeOfIso(iso: string, weekStartIso: string): DayCode {
  const offset = Math.round(
    (new Date(iso + "T00:00:00Z").getTime() - new Date(weekStartIso + "T00:00:00Z").getTime()) / 86_400_000
  );
  return DAY_CODES[Math.max(0, Math.min(DAY_CODES.length - 1, offset))];
}

const KIND_LABEL: Record<SessionRow["session_type"], string> = {
  easy: "Facile",
  long: "Longue facile",
  threshold: "Qualité",
  vo2max: "Qualité",
  rest: "Repos",
  race: "Course",
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function DayPicker({
  currentDay,
  availableDays,
  takenDays,
  disabled,
  onPick,
}: {
  currentDay: DayCode;
  availableDays: DayCode[];
  takenDays: Set<DayCode>;
  disabled: boolean;
  onPick: (day: DayCode) => void;
}) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      <span className="text-[10px] text-gray-400 mr-0.5">Jour :</span>
      {availableDays.map((d) => {
        const isCurrent = d === currentDay;
        const isTaken = !isCurrent && takenDays.has(d);
        return (
          <button
            key={d}
            type="button"
            disabled={disabled || isTaken}
            onClick={() => onPick(d)}
            className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
              isCurrent
                ? "bg-gray-800 text-white border-gray-800"
                : isTaken
                  ? "border-gray-100 text-gray-300 cursor-not-allowed"
                  : "border-gray-200 text-gray-500 hover:border-gray-400"
            }`}
          >
            {DAY_LABELS_FR[d]}
          </button>
        );
      })}
    </div>
  );
}

function ShoePicker({
  session,
  shoes,
  disabled,
  onSetShoe,
}: {
  session: SessionRow;
  shoes: ShoeOption[];
  disabled: boolean;
  onSetShoe: (sessionId: string, shoeId: string | null) => void;
}) {
  const selected = shoes.find((s) => s.id === session.shoe_id) ?? null;

  return (
    <div className="flex items-center gap-2 mb-3 flex-wrap">
      <span className="text-[10px] text-gray-400">Paire :</span>
      <select
        value={session.shoe_id ?? ""}
        disabled={disabled}
        onChange={(e) => onSetShoe(session.id, e.target.value || null)}
        className="text-xs border border-gray-200 rounded px-2 py-1 bg-white focus:outline-none focus:border-gray-400 disabled:opacity-50"
      >
        <option value="">— Choisir —</option>
        {shoes
          .filter((s) => !s.retired || s.id === session.shoe_id)
          .map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
      </select>
      {selected && (
        <span className={`w-2 h-2 rounded-full ${WEAR_DOT_CLASS[wearLevel(selected.total_km)]}`} title={`${selected.total_km} km`} />
      )}
    </div>
  );
}

function SessionCard({
  session,
  weekStartIso,
  availableDays,
  takenDays,
  shoes,
  moving,
  settingShoe,
  onMove,
  onReset,
  onSkip,
  onSetShoe,
}: {
  session: SessionRow;
  weekStartIso: string;
  availableDays: DayCode[];
  takenDays: Set<DayCode>;
  shoes: ShoeOption[];
  moving: boolean;
  settingShoe: boolean;
  onMove: (sessionId: string, day: DayCode) => void;
  onReset: (sessionId: string) => void;
  onSkip: (sessionId: string, skipped: boolean) => void;
  onSetShoe: (sessionId: string, shoeId: string | null) => void;
}) {
  const isRest = session.session_type === "rest";
  const isRace = session.session_type === "race";
  const currentDay = dayCodeOfIso(session.planned_date, weekStartIso);

  return (
    <div className="border border-gray-200 rounded-lg p-4">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="text-xs text-gray-400 capitalize">{fmtDay(session.planned_date)}</span>
        <div className="flex items-center gap-1.5">
          {session.indoor && !isRest && (
            <span className="text-[10px] uppercase tracking-wide text-gray-400 border border-gray-200 rounded px-1.5 py-0.5">
              Tapis{session.incline_percent ? ` · ${session.incline_percent}%` : ""}
            </span>
          )}
          {session.modality === "non_impact" && !isRest && (
            <span className="text-[10px] uppercase tracking-wide text-gray-400 border border-gray-200 rounded px-1.5 py-0.5">
              {session.machine ? MACHINE_LABEL_FR[session.machine] : "Cardio"}
            </span>
          )}
        </div>
      </div>
      <h3 className="text-sm font-medium text-gray-800 mb-1">
        {session.session_label ?? KIND_LABEL[session.session_type]}
      </h3>

      {session.why_note && <p className="text-xs text-gray-500 mb-3">{session.why_note}</p>}

      {isRace && session.pain_warning && (
        <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">
          {RACE_PAIN_WARNING}
        </p>
      )}

      {!isRest && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600 mb-3">
          {isRace ? (
            session.target_distance_km != null && (
              <span>{session.target_distance_km.toLocaleString("fr-FR")} km · pas d&apos;objectif de temps</span>
            )
          ) : (
            <>
              <span>{session.target_duration_minutes} min</span>
              {session.target_distance_km != null && <span>≈ {session.target_distance_km} km</span>}
            </>
          )}
          {session.target_pace_sec_per_km != null && <span>≈ {fmtPace(session.target_pace_sec_per_km)}</span>}
          {session.zone_summary && <span className="text-gray-400">{session.zone_summary}</span>}
        </div>
      )}

      {session.actual && !isRace && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-green-700 mb-2">
          <span>Réel :</span>
          {session.actual.durationMinutes != null && <span>{session.actual.durationMinutes} min</span>}
          {session.actual.distanceKm != null && <span>{session.actual.distanceKm} km</span>}
          {session.actual.avgPaceSecPerKm != null && <span>{fmtPace(session.actual.avgPaceSecPerKm)}</span>}
        </div>
      )}

      {session.completed && (
        <div className="mb-3">
          <CompletionCartouche
            score={session.completion_score}
            note={session.completion_note}
            analysis={session.completion_analysis}
            result={isRace ? (session.actual ?? { durationSeconds: null, distanceKm: null, avgPaceSecPerKm: null, avgHeartRate: null }) : null}
          />
        </div>
      )}

      {session.completed && (
        <ShoePicker session={session} shoes={shoes} disabled={settingShoe} onSetShoe={onSetShoe} />
      )}

      {session.skipped && (
        <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 mb-3">
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-red-700 bg-white border border-red-200 rounded px-1.5 py-0.5">
            ✗ Non réalisée
          </span>
        </div>
      )}

      {session.steps && session.steps.length > 0 && (
        <div className="space-y-1.5">
          {session.steps.map((step, i) => (
            <div key={i} className="text-xs flex gap-2">
              <span className="w-32 shrink-0 text-gray-500">{step.label}</span>
              <span className="flex-1 text-gray-700">
                {step.durationMinutes != null ? `${step.durationMinutes} min — ` : ""}
                {step.description}
              </span>
              {(step.heartRateHint || step.paceHint) && (
                <span className="shrink-0 text-gray-400 tabular-nums">
                  {[step.heartRateHint, step.paceHint].filter(Boolean).join(" / ")}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {session.strides_added && (
        <p className="text-[11px] text-gray-400 mt-2">Bonne énergie récente → lignes droites ajoutées en fin de séance.</p>
      )}
      {session.downgrade_reason && (
        <p className="text-[11px] text-amber-600 mt-2">Adaptée : {session.downgrade_reason}</p>
      )}

      {!isRest && (
        <div className="mt-3 pt-2.5 border-t border-gray-100 flex items-center justify-between gap-2 flex-wrap">
          {!session.completed && !session.skipped ? (
            <DayPicker
              currentDay={currentDay}
              availableDays={availableDays}
              takenDays={takenDays}
              disabled={moving}
              onPick={(day) => onMove(session.id, day)}
            />
          ) : (
            <span />
          )}
          <div className="flex items-center gap-3">
            {session.manual_day_override && !session.completed && !session.skipped && (
              <button
                type="button"
                disabled={moving}
                onClick={() => onReset(session.id)}
                className="text-[10px] text-gray-400 underline hover:text-gray-600 disabled:opacity-50 transition-colors"
              >
                Réinitialiser
              </button>
            )}
            <label className="flex items-center gap-1.5 text-[10px] text-gray-500">
              <input
                type="checkbox"
                checked={session.skipped}
                disabled={moving}
                onChange={(e) => onSkip(session.id, e.target.checked)}
                className="accent-red-600"
              />
              Non réalisée
            </label>
          </div>
        </div>
      )}
      {session.day_override_dropped && (
        <p className="text-[11px] text-amber-600 mt-2">
          Jour déplacé — le jour choisi n&apos;est plus disponible cette semaine.
        </p>
      )}
    </div>
  );
}

function ZoneLegend({ zones }: { zones: Record<EffortZoneId, EffortZone> }) {
  return (
    <details className="text-xs text-gray-500">
      <summary className="cursor-pointer select-none">Ça correspond à quoi, les zones ?</summary>
      <div className="mt-2 space-y-1.5">
        {Object.values(zones).map((z) => (
          <div key={z.id} className="flex gap-2">
            <span className="w-20 shrink-0 text-gray-600">{z.label}</span>
            <span className="w-24 shrink-0 tabular-nums text-gray-400">
              {z.bpmMin}–{z.bpmMax} bpm
            </span>
            <span>{z.feeling}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

const MACHINE_LABEL_CAP: Record<NonImpactMachine, string> = {
  bike: "Vélo d'appartement",
  assault_bike: "Assault bike",
  elliptical: "Élliptique",
};

function SetupForm({
  initialRuns,
  initialIndoor,
  initialNonImpact,
  initialMachines,
  initialAvailableDays,
  isSuggestion,
  onSubmit,
  submitting,
}: {
  initialRuns: number;
  initialIndoor: number;
  initialNonImpact: number;
  initialMachines: NonImpactMachine[];
  initialAvailableDays: DayCode[];
  isSuggestion: boolean;
  onSubmit: (
    runsPerWeek: number,
    indoorRuns: number,
    nonImpactSessions: number,
    nonImpactMachines: NonImpactMachine[],
    availableDays: DayCode[]
  ) => void;
  submitting: boolean;
}) {
  // Running sessions: 3 to 5 a week (4 by default). Non-impact cardio is an optional extra on top.
  const [runs, setRuns] = useState(Math.min(5, Math.max(3, initialRuns)));
  const [extra, setExtra] = useState(Math.min(2, initialNonImpact));
  const [indoor, setIndoor] = useState(Math.min(initialIndoor, Math.min(5, Math.max(3, initialRuns))));
  const [machines, setMachines] = useState<NonImpactMachine[]>(initialMachines);
  const [days, setDays] = useState<DayCode[]>(
    initialAvailableDays.length > 0 ? initialAvailableDays : [...DAY_CODES]
  );

  const nonImpact = extra;
  const total = runs + extra;

  function toggleMachine(m: NonImpactMachine) {
    setMachines((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));
  }

  function toggleDay(d: DayCode) {
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));
  }

  const notEnoughDays = days.length < total;
  const missingMachine = nonImpact > 0 && machines.length === 0;

  return (
    <div className="space-y-4">
      <div>
        <span className="text-xs text-gray-500 block mb-2">
          Combien de sorties course à pied cette semaine ?
          {isSuggestion && <span className="text-gray-400"> (conseillé : 4)</span>}
        </span>
        <div className="flex gap-2">
          {([3, 4, 5] as const).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => {
                setRuns(n);
                if (indoor > n) setIndoor(n);
              }}
              className={`px-6 py-2.5 min-h-[44px] text-base rounded-lg border transition-colors ${
                runs === n
                  ? "bg-gray-800 text-white border-gray-800"
                  : "border-gray-200 text-gray-700 hover:border-gray-400"
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <div>
        <span className="text-xs text-gray-500 block mb-2">En plus, des séances sans impact (vélo, élliptique) ?</span>
        <div className="flex gap-2">
          {([0, 1, 2] as const).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setExtra(n)}
              className={`px-6 py-2.5 min-h-[44px] text-base rounded-lg border transition-colors ${
                extra === n
                  ? "bg-gray-800 text-white border-gray-800"
                  : "border-gray-200 text-gray-700 hover:border-gray-400"
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      {runs > 0 && (
        <div>
          <span className="text-xs text-gray-500 block mb-2">Dont combien en intérieur (tapis) ?</span>
          <div className="flex gap-2">
            {Array.from({ length: runs + 1 }, (_, i) => i).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setIndoor(n)}
                className={`px-5 py-2.5 min-h-[44px] text-base rounded-lg border transition-colors ${
                  indoor === n
                    ? "bg-gray-800 text-white border-gray-800"
                    : "border-gray-200 text-gray-600 hover:border-gray-400"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      )}

      {nonImpact > 0 && (
        <div>
          <span className="text-xs text-gray-500 block mb-2">Quelles machines as-tu à disposition ?</span>
          <div className="flex gap-2 flex-wrap">
            {NON_IMPACT_MACHINES.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => toggleMachine(m)}
                className={`px-3.5 py-2.5 min-h-[44px] text-sm rounded-lg border transition-colors ${
                  machines.includes(m)
                    ? "bg-gray-800 text-white border-gray-800"
                    : "border-gray-200 text-gray-600 hover:border-gray-400"
                }`}
              >
                {MACHINE_LABEL_CAP[m]}
              </button>
            ))}
          </div>
          {missingMachine && (
            <p className="text-xs text-red-500 mt-1.5">Sélectionne au moins une machine.</p>
          )}
        </div>
      )}

      <div>
        <span className="text-xs text-gray-500 block mb-2">Quels jours es-tu disponible pour t&apos;entraîner ?</span>
        <div className="flex gap-1.5 flex-wrap">
          {DAY_CODES.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => toggleDay(d)}
              className={`px-3.5 py-2.5 min-h-[44px] text-sm rounded-lg border transition-colors ${
                days.includes(d)
                  ? "bg-gray-800 text-white border-gray-800"
                  : "border-gray-200 text-gray-600 hover:border-gray-400"
              }`}
            >
              {DAY_LABELS_FR[d]}
            </button>
          ))}
        </div>
        {notEnoughDays && (
          <p className="text-xs text-red-500 mt-1.5">
            Sélectionne au moins {total} jour{total > 1 ? "s" : ""} disponible{total > 1 ? "s" : ""}.
          </p>
        )}
      </div>

      <button
        type="button"
        disabled={submitting || notEnoughDays || missingMachine}
        onClick={() => onSubmit(runs, indoor, nonImpact, machines, days)}
        className="px-4 py-2 text-sm font-medium text-white bg-accent rounded hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        {submitting ? "Génération…" : "Générer la semaine →"}
      </button>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function WeeklyPlanCard() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [userId, setUserId] = useState<string | null>(null);
  const [week, setWeek] = useState<WeekResponse | null>(null);
  const [shoes, setShoes] = useState<ShoeOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [movingSessionId, setMovingSessionId] = useState<string | null>(null);
  const [settingShoeSessionId, setSettingShoeSessionId] = useState<string | null>(null);

  const load = useCallback(async (uid: string) => {
    setError(null);
    try {
      const r = await fetch(`/api/plan/week?userId=${uid}`);
      const data: WeekResponse = await r.json();
      setWeek(data);
      setPhase(data.setup ? "ready" : "setup");
    } catch {
      setError("Impossible de charger la semaine.");
      setPhase("setup");
    }
  }, []);

  const loadShoes = useCallback(async (uid: string) => {
    try {
      const r = await fetch(`/api/shoes?userId=${uid}`);
      const data = await r.json();
      if (r.ok && !data.error) setShoes(data.shoes);
    } catch {
      // Best-effort — the shoe picker just won't have options if this fails.
    }
  }, []);

  useEffect(() => {
    const id = localStorage.getItem("marathon_user_id");
    if (!id) {
      setPhase("no-user");
      return;
    }
    setUserId(id);
    void load(id);
    void loadShoes(id);
  }, [load, loadShoes]);

  async function handleGenerate(
    runsPerWeek: number,
    indoorRuns: number,
    nonImpactSessions: number,
    nonImpactMachines: NonImpactMachine[],
    availableDays: DayCode[]
  ) {
    if (!userId) return;
    setPhase("saving");
    setError(null);
    try {
      const r = await fetch("/api/plan/week", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, runsPerWeek, indoorRuns, nonImpactSessions, nonImpactMachines, availableDays }),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        setError(data.error ?? "La génération a échoué.");
        setPhase("setup");
        return;
      }
      setWeek({
        weekStart: data.weekStart,
        setup: { runsPerWeek, indoorRuns, nonImpactSessions, nonImpactMachines, availableDays },
        suggestedRunsPerWeek: data.suggestedRunsPerWeek,
        zones: data.zones,
        sessions: data.sessions,
      });
      setEditing(false);
      setPhase("ready");
      window.dispatchEvent(new Event(SESSIONS_CHANGED_EVENT));
    } catch {
      setError("La génération a échoué.");
      setPhase("setup");
    }
  }

  async function handleMove(sessionId: string, dayCode: DayCode) {
    if (!userId) return;
    setMovingSessionId(sessionId);
    setError(null);
    try {
      const r = await fetch("/api/plan/session", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, sessionId, action: "move", dayCode }),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        setError(data.error ?? "Le déplacement a échoué.");
        return;
      }
      setWeek((prev) =>
        prev
          ? {
              ...prev,
              sessions: prev.sessions.map((s) =>
                s.id === data.session.id ? { ...s, ...data.session, day_override_dropped: false } : s
              ),
            }
          : prev
      );
    } catch {
      setError("Le déplacement a échoué.");
    } finally {
      setMovingSessionId(null);
    }
  }

  async function handleReset(sessionId: string) {
    if (!userId) return;
    setMovingSessionId(sessionId);
    setError(null);
    try {
      const r = await fetch("/api/plan/session", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, sessionId, action: "reset" }),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        setError(data.error ?? "La réinitialisation a échoué.");
        return;
      }
      setWeek((prev) => (prev ? { ...prev, sessions: data.sessions } : prev));
    } catch {
      setError("La réinitialisation a échoué.");
    } finally {
      setMovingSessionId(null);
    }
  }

  async function handleSkip(sessionId: string, skipped: boolean) {
    if (!userId) return;
    setMovingSessionId(sessionId);
    setError(null);
    try {
      const r = await fetch("/api/plan/session", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, sessionId, action: "skip", skipped }),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        setError(data.error ?? "La mise à jour a échoué.");
        return;
      }
      setWeek((prev) =>
        prev
          ? { ...prev, sessions: prev.sessions.map((s) => (s.id === data.session.id ? { ...s, ...data.session } : s)) }
          : prev
      );
      window.dispatchEvent(new Event(SESSIONS_CHANGED_EVENT));
    } catch {
      setError("La mise à jour a échoué.");
    } finally {
      setMovingSessionId(null);
    }
  }

  async function handleSetShoe(sessionId: string, shoeId: string | null) {
    if (!userId) return;
    setSettingShoeSessionId(sessionId);
    setError(null);
    try {
      const r = await fetch("/api/plan/session", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, sessionId, action: "setShoe", shoeId }),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        setError(data.error ?? "La mise à jour a échoué.");
        return;
      }
      setWeek((prev) =>
        prev
          ? { ...prev, sessions: prev.sessions.map((s) => (s.id === data.session.id ? { ...s, ...data.session } : s)) }
          : prev
      );
      await loadShoes(userId);
    } catch {
      setError("La mise à jour a échoué.");
    } finally {
      setSettingShoeSessionId(null);
    }
  }

  if (phase === "no-user") {
    return (
      <p className="text-xs text-gray-500">
        <a href="/onboarding" className="underline">
          Complète ton profil
        </a>{" "}
        pour générer ta semaine.
      </p>
    );
  }

  if (phase === "loading") {
    return <p className="text-xs text-gray-400">Chargement…</p>;
  }

  const showSetupForm = phase === "setup" || phase === "saving" || editing;
  const availableDays = week?.setup?.availableDays ?? [...DAY_CODES];

  return (
    <div className="space-y-4">
      {error && <p className="text-xs text-red-500">{error}</p>}

      {showSetupForm ? (
        <SetupForm
          initialRuns={week?.setup?.runsPerWeek ?? 4}
          initialIndoor={week?.setup?.indoorRuns ?? 0}
          initialNonImpact={week?.setup?.nonImpactSessions ?? 0}
          initialMachines={week?.setup?.nonImpactMachines ?? []}
          initialAvailableDays={availableDays}
          isSuggestion={!week?.setup}
          onSubmit={handleGenerate}
          submitting={phase === "saving"}
        />
      ) : (
        <>
          <div className="flex items-center justify-between">
            <p className="text-xs text-gray-500">
              {week?.setup?.runsPerWeek ?? 0} sortie{(week?.setup?.runsPerWeek ?? 0) > 1 ? "s" : ""}
              {week?.setup?.nonImpactSessions
                ? ` + ${week.setup.nonImpactSessions} cardio sans impact`
                : ""}{" "}
              cette semaine
              {week?.setup?.indoorRuns ? `, dont ${week.setup.indoorRuns} en intérieur` : ""}.
            </p>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-xs text-gray-400 underline hover:text-gray-600 transition-colors"
            >
              Changer
            </button>
          </div>

          <div className="space-y-3">
            {(week?.sessions ?? []).map((s) => {
              const takenDays = new Set(
                (week?.sessions ?? [])
                  .filter((other) => other.id !== s.id && other.session_type !== "rest")
                  .map((other) => dayCodeOfIso(other.planned_date, week!.weekStart))
              );
              return (
                <SessionCard
                  key={s.id}
                  session={s}
                  weekStartIso={week!.weekStart}
                  availableDays={availableDays}
                  takenDays={takenDays}
                  shoes={shoes}
                  moving={movingSessionId === s.id}
                  settingShoe={settingShoeSessionId === s.id}
                  onMove={handleMove}
                  onReset={handleReset}
                  onSkip={handleSkip}
                  onSetShoe={handleSetShoe}
                />
              );
            })}
          </div>

          {week && <ZoneLegend zones={week.zones} />}
        </>
      )}
    </div>
  );
}
