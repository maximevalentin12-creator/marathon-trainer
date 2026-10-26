"use client";

import { useState } from "react";
import {
  INJURY_ZONES,
  type InjurySide,
  type InjuryZone,
  type PainOnset,
} from "@/lib/debrief/types";
import {
  ENERGY_LABEL_FR,
  ENJOYMENT_LABEL_FR,
  LEGS_LABEL_FR,
  ONSET_LABEL_FR,
  SIDE_LABEL_FR,
  ZONE_LABEL_FR,
} from "@/lib/debrief/labels";

/** Broadcast once a debrief is saved so the plan card and the banner reload. */
export const DEBRIEF_SAVED_EVENT = "marathon:debrief-saved";

export interface DebriefTarget {
  garminActivityId: number | null;
  plannedSessionId: string | null;
  /** YYYY-MM-DD. */
  date: string;
  /** Shown in the sheet header. */
  label: string;
}

function Choice({
  selected,
  onClick,
  children,
  className = "",
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`min-h-[44px] rounded-lg border px-2 text-sm transition-colors ${
        selected ? "border-green-700 bg-green-700 text-white" : "border-gray-300 bg-white text-gray-700 hover:border-gray-500"
      } ${className}`}
    >
      {children}
    </button>
  );
}

/** 1-5 buttons with the label of the picked value underneath. */
function FiveScale({
  title,
  value,
  labels,
  onChange,
}: {
  title: string;
  value: number;
  labels: string[];
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-sm font-medium text-gray-800">{title}</span>
        <span className="text-xs text-gray-500">{labels[value - 1]}</span>
      </div>
      <div className="grid grid-cols-5 gap-1.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <Choice key={n} selected={value === n} onClick={() => onChange(n)}>
            {n}
          </Choice>
        ))}
      </div>
    </div>
  );
}

function Slider({
  title,
  value,
  min,
  max,
  hint,
  onChange,
}: {
  title: string;
  value: number;
  min: number;
  max: number;
  hint?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-sm font-medium text-gray-800">{title}</span>
        <span className="text-base font-semibold tabular-nums text-gray-900">
          {value}
          <span className="text-xs font-normal text-gray-400"> / {max}</span>
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={title}
        className="w-full h-11 accent-green-700"
      />
      {hint && <div className="flex justify-between text-[11px] text-gray-400 -mt-1">{hint.split("|").map((h) => <span key={h}>{h}</span>)}</div>}
    </div>
  );
}

const MAX_PAINS = 2;

interface PainDraft {
  zone: InjuryZone | null;
  side: InjurySide | null;
  intensity: number;
  onset: PainOnset | null;
  affectsGait: boolean;
}

const newPain = (): PainDraft => ({ zone: null, side: null, intensity: 3, onset: null, affectsGait: false });

const needsSide = (p: PainDraft) => p.zone !== null && p.zone !== "back" && p.zone !== "other";
const painComplete = (p: PainDraft) => p.zone !== null && (!needsSide(p) || p.side !== null) && p.onset !== null;

function PainForm({
  title,
  draft,
  onChange,
  onRemove,
}: {
  title: string | null;
  draft: PainDraft;
  onChange: (next: PainDraft) => void;
  onRemove: (() => void) | null;
}) {
  const set = (patch: Partial<PainDraft>) => onChange({ ...draft, ...patch });
  return (
    <div className="space-y-4 rounded-lg border border-amber-200 bg-amber-50/50 p-3">
      {(title || onRemove) && (
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-800">{title}</span>
          {onRemove && (
            <button type="button" onClick={onRemove} className="min-h-[44px] px-2 text-xs text-gray-500 underline">
              Retirer
            </button>
          )}
        </div>
      )}
      <div>
        <span className="block text-sm font-medium text-gray-800 mb-1.5">Où ?</span>
        <div className="grid grid-cols-3 gap-1.5">
          {INJURY_ZONES.map((z) => (
            <Choice key={z} selected={draft.zone === z} onClick={() => set({ zone: z })}>
              {ZONE_LABEL_FR[z]}
            </Choice>
          ))}
        </div>
      </div>

      {needsSide(draft) && (
        <div>
          <span className="block text-sm font-medium text-gray-800 mb-1.5">Quel côté ?</span>
          <div className="grid grid-cols-3 gap-1.5">
            {(["left", "right", "both"] as const).map((sd) => (
              <Choice key={sd} selected={draft.side === sd} onClick={() => set({ side: sd })}>
                {SIDE_LABEL_FR[sd]}
              </Choice>
            ))}
          </div>
        </div>
      )}

      <Slider
        title="Intensité"
        value={draft.intensity}
        min={0}
        max={10}
        hint="Gêne légère|Insupportable"
        onChange={(v) => set({ intensity: v })}
      />

      <div>
        <span className="block text-sm font-medium text-gray-800 mb-1.5">Elle est apparue…</span>
        <div className="grid grid-cols-3 gap-1.5">
          {(["before", "during", "after"] as const).map((o) => (
            <Choice key={o} selected={draft.onset === o} onClick={() => set({ onset: o })} className="text-xs">
              {ONSET_LABEL_FR[o]}
            </Choice>
          ))}
        </div>
      </div>

      <div>
        <span className="block text-sm font-medium text-gray-800 mb-1.5">Elle change ta foulée ?</span>
        <div className="grid grid-cols-2 gap-1.5">
          <Choice selected={!draft.affectsGait} onClick={() => set({ affectsGait: false })}>
            Non
          </Choice>
          <Choice selected={draft.affectsGait} onClick={() => set({ affectsGait: true })}>
            Oui, je boite / je compense
          </Choice>
        </div>
      </div>
    </div>
  );
}

export default function DebriefSheet({
  target,
  onClose,
  onSaved,
}: {
  target: DebriefTarget;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [effort, setEffort] = useState(5);
  const [legs, setLegs] = useState(3);
  const [energy, setEnergy] = useState(3);
  const [enjoyment, setEnjoyment] = useState(3);
  const [hasPain, setHasPain] = useState(false);
  const [pains, setPains] = useState<PainDraft[]>([newPain()]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allPainComplete = pains.every(painComplete);
  const canSave = !saving && (!hasPain || allPainComplete);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/debriefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          garminActivityId: target.garminActivityId,
          plannedSessionId: target.plannedSessionId,
          date: target.date,
          effort,
          legs,
          energy,
          enjoyment,
          notes: notes.trim() || null,
          pain: hasPain
            ? pains.map((p) => ({
                zone: p.zone,
                side: needsSide(p) ? p.side : "both",
                intensity: p.intensity,
                onset: p.onset,
                affectsGait: p.affectsGait,
              }))
            : [],
        }),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        setError(data.error ?? "L'enregistrement a échoué.");
        setSaving(false);
        return;
      }
      window.dispatchEvent(new Event(DEBRIEF_SAVED_EVENT));
      onSaved?.();
      onClose();
    } catch {
      setError("L'enregistrement a échoué.");
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="Débrief de la sortie"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div className="w-full md:max-w-md max-h-[92vh] overflow-y-auto overscroll-contain rounded-t-2xl md:rounded-2xl bg-white px-4 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-gray-900">Débrief</h2>
            <p className="text-xs text-gray-500 truncate">{target.label}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Fermer"
            className="shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2 text-gray-400 hover:text-gray-700 text-xl"
          >
            ×
          </button>
        </div>

        <div className="space-y-5">
          <Slider title="Effort ressenti" value={effort} min={1} max={10} hint="Très facile|Très dur" onChange={setEffort} />
          <FiveScale title="Jambes" value={legs} labels={LEGS_LABEL_FR} onChange={setLegs} />
          <FiveScale title="Énergie" value={energy} labels={ENERGY_LABEL_FR} onChange={setEnergy} />
          <FiveScale title="Plaisir" value={enjoyment} labels={ENJOYMENT_LABEL_FR} onChange={setEnjoyment} />

          <div>
            <span className="block text-sm font-medium text-gray-800 mb-1.5">Une douleur ?</span>
            <div className="grid grid-cols-2 gap-1.5">
              <Choice selected={!hasPain} onClick={() => setHasPain(false)}>
                Non
              </Choice>
              <Choice selected={hasPain} onClick={() => setHasPain(true)}>
                Oui
              </Choice>
            </div>
          </div>

          {hasPain && (
            <>
              {pains.map((p, i) => (
                <PainForm
                  key={i}
                  title={pains.length > 1 ? `Douleur ${i + 1}` : null}
                  draft={p}
                  onChange={(next) => setPains((all) => all.map((d, j) => (j === i ? next : d)))}
                  onRemove={i > 0 ? () => setPains((all) => all.filter((_, j) => j !== i)) : null}
                />
              ))}
              {pains.length < MAX_PAINS && (
                <button
                  type="button"
                  onClick={() => setPains((all) => [...all, newPain()])}
                  className="w-full min-h-[44px] rounded-lg border border-dashed border-gray-300 text-sm text-gray-600 hover:border-gray-500"
                >
                  + Une autre zone douloureuse
                </button>
              )}
            </>
          )}

          <details className="text-sm">
            <summary className="cursor-pointer select-none text-gray-500 min-h-[44px] flex items-center">
              Ajouter une note (facultatif)
            </summary>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={500}
              className="mt-1 w-full rounded-lg border border-gray-300 p-2 text-base"
            />
          </details>
        </div>

        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className="mt-5 w-full min-h-[48px] rounded-lg bg-green-700 text-white text-sm font-medium disabled:opacity-40"
        >
          {saving ? "Enregistrement…" : hasPain && !allPainComplete ? "Précise la douleur pour enregistrer" : "Enregistrer"}
        </button>
      </div>
    </div>
  );
}
