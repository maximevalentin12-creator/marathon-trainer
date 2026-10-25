"use client";

import { useState, useEffect, useCallback } from "react";
import { wearLevel, WEAR_NOTE, WEAR_DOT_CLASS, WEAR_TEXT_CLASS } from "@/lib/shoes";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Shoe {
  id: string;
  name: string;
  brand: string | null;
  model: string | null;
  drop_mm: number | null;
  stack_heel_mm: number | null;
  stack_forefoot_mm: number | null;
  weight_g: number | null;
  usage_type: string | null;
  image_url: string | null;
  notes: string | null;
  total_km: number;
  retired: boolean;
}

interface ShoeFormValues {
  name: string;
  brand: string;
  model: string;
  dropMm: string;
  stackHeelMm: string;
  stackForefootMm: string;
  weightG: string;
  usageType: string;
  imageUrl: string;
  notes: string;
  totalKm: string;
}

const EMPTY_FORM: ShoeFormValues = {
  name: "",
  brand: "",
  model: "",
  dropMm: "",
  stackHeelMm: "",
  stackForefootMm: "",
  weightG: "",
  usageType: "",
  imageUrl: "",
  notes: "",
  totalKm: "0",
};

function shoeToForm(s: Shoe): ShoeFormValues {
  return {
    name: s.name,
    brand: s.brand ?? "",
    model: s.model ?? "",
    dropMm: s.drop_mm != null ? String(s.drop_mm) : "",
    stackHeelMm: s.stack_heel_mm != null ? String(s.stack_heel_mm) : "",
    stackForefootMm: s.stack_forefoot_mm != null ? String(s.stack_forefoot_mm) : "",
    weightG: s.weight_g != null ? String(s.weight_g) : "",
    usageType: s.usage_type ?? "",
    imageUrl: s.image_url ?? "",
    notes: s.notes ?? "",
    totalKm: String(s.total_km),
  };
}

function numOrNull(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

const inputCls =
  "w-full px-3 py-1.5 text-sm border border-gray-200 rounded focus:outline-none focus:border-gray-400 bg-white";
const textareaCls = `${inputCls} resize-none`;

// ─── Wear indicator ─────────────────────────────────────────────────────────

function WearBadge({ totalKm }: { totalKm: number }) {
  const level = wearLevel(totalKm);
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${WEAR_TEXT_CLASS[level]}`}>
      <span className={`w-2 h-2 rounded-full ${WEAR_DOT_CLASS[level]}`} />
      {totalKm} km
    </span>
  );
}

// ─── Shoe card ──────────────────────────────────────────────────────────────

function ShoeCard({ shoe, onClick }: { shoe: Shoe; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left border rounded-lg p-4 hover:border-gray-400 transition-colors ${
        shoe.retired ? "border-gray-100 opacity-60" : "border-gray-200"
      }`}
    >
      <div className="aspect-[4/3] mb-3 rounded bg-gray-50 border border-gray-100 flex items-center justify-center overflow-hidden">
        {shoe.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shoe.image_url} alt={shoe.name} className="w-full h-full object-cover" />
        ) : (
          <span className="text-xs text-gray-300">Pas d&apos;image</span>
        )}
      </div>
      <h3 className="text-sm font-medium text-gray-800">{shoe.name}</h3>
      <p className="text-xs text-gray-500 mb-2">
        {[shoe.brand, shoe.model].filter(Boolean).join(" · ") || "—"}
      </p>
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-400">{shoe.drop_mm != null ? `Drop ${shoe.drop_mm} mm` : "Drop —"}</span>
        <WearBadge totalKm={shoe.total_km} />
      </div>
      {shoe.retired && <p className="text-[10px] uppercase tracking-wide text-gray-400 mt-2">Retirée</p>}
    </button>
  );
}

// ─── Add/edit form ──────────────────────────────────────────────────────────

function ShoeForm({
  initial,
  title,
  submitLabel,
  onSubmit,
  onCancel,
  submitting,
}: {
  initial: ShoeFormValues;
  title: string;
  submitLabel: string;
  onSubmit: (values: ShoeFormValues) => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  const [values, setValues] = useState(initial);

  function set<K extends keyof ShoeFormValues>(key: K, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-gray-800">{title}</h3>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="text-xs text-gray-500 block mb-1">Nom *</label>
          <input className={inputCls} value={values.name} onChange={(e) => set("name", e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">Marque</label>
          <input className={inputCls} value={values.brand} onChange={(e) => set("brand", e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">Modèle</label>
          <input className={inputCls} value={values.model} onChange={(e) => set("model", e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">Drop (mm)</label>
          <input className={inputCls} value={values.dropMm} onChange={(e) => set("dropMm", e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">Poids (g)</label>
          <input className={inputCls} value={values.weightG} onChange={(e) => set("weightG", e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">Stack talon (mm)</label>
          <input
            className={inputCls}
            value={values.stackHeelMm}
            onChange={(e) => set("stackHeelMm", e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">Stack avant-pied (mm)</label>
          <input
            className={inputCls}
            value={values.stackForefootMm}
            onChange={(e) => set("stackForefootMm", e.target.value)}
          />
        </div>
        <div className="col-span-2">
          <label className="text-xs text-gray-500 block mb-1">Usage</label>
          <input
            className={inputCls}
            placeholder="ex : daily/long run, tapis, tempo…"
            value={values.usageType}
            onChange={(e) => set("usageType", e.target.value)}
          />
        </div>
        <div className="col-span-2">
          <label className="text-xs text-gray-500 block mb-1">Image (URL)</label>
          <input className={inputCls} value={values.imageUrl} onChange={(e) => set("imageUrl", e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">Km cumulés</label>
          <input className={inputCls} value={values.totalKm} onChange={(e) => set("totalKm", e.target.value)} />
        </div>
        <div className="col-span-2">
          <label className="text-xs text-gray-500 block mb-1">Notes</label>
          <textarea
            rows={4}
            className={textareaCls}
            value={values.notes}
            onChange={(e) => set("notes", e.target.value)}
          />
        </div>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          disabled={submitting || !values.name.trim()}
          onClick={() => onSubmit(values)}
          className="px-4 py-2 text-sm font-medium text-white bg-accent rounded hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {submitting ? "Enregistrement…" : submitLabel}
        </button>
        <button type="button" onClick={onCancel} className="text-xs text-gray-400 underline hover:text-gray-600">
          Annuler
        </button>
      </div>
    </div>
  );
}

// ─── Detail / edit modal ────────────────────────────────────────────────────

function ShoeDetail({
  shoe,
  onClose,
  onSave,
  onDelete,
  onToggleRetired,
  saving,
}: {
  shoe: Shoe;
  onClose: () => void;
  onSave: (values: ShoeFormValues) => void;
  onDelete: () => void;
  onToggleRetired: () => void;
  saving: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const level = wearLevel(shoe.total_km);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div
        className="bg-white rounded-lg p-5 max-w-md w-full max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {editing ? (
          <ShoeForm
            initial={shoeToForm(shoe)}
            title="Modifier la paire"
            submitLabel="Enregistrer"
            submitting={saving}
            onCancel={() => setEditing(false)}
            onSubmit={onSave}
          />
        ) : (
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-sm font-medium text-gray-800">{shoe.name}</h3>
              <button onClick={onClose} className="text-xs text-gray-400 hover:text-gray-600">
                Fermer ✕
              </button>
            </div>

            {shoe.image_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={shoe.image_url} alt={shoe.name} className="w-full rounded object-cover max-h-48" />
            )}

            <p className="text-xs text-gray-500">{[shoe.brand, shoe.model].filter(Boolean).join(" · ") || "—"}</p>

            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-600">
              <span>Drop : {shoe.drop_mm != null ? `${shoe.drop_mm} mm` : "—"}</span>
              <span>Poids : {shoe.weight_g != null ? `${shoe.weight_g} g` : "—"}</span>
              <span>Stack talon : {shoe.stack_heel_mm != null ? `${shoe.stack_heel_mm} mm` : "—"}</span>
              <span>Stack avant-pied : {shoe.stack_forefoot_mm != null ? `${shoe.stack_forefoot_mm} mm` : "—"}</span>
              <span className="col-span-2">Usage : {shoe.usage_type ?? "—"}</span>
            </div>

            <div className={`text-sm font-medium ${WEAR_TEXT_CLASS[level]}`}>
              <WearWithNote totalKm={shoe.total_km} />
            </div>

            {shoe.notes && <p className="text-xs text-gray-600 whitespace-pre-wrap">{shoe.notes}</p>}

            <div className="flex items-center gap-3 pt-2 border-t border-gray-100">
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="text-xs text-gray-500 underline hover:text-gray-700"
              >
                Modifier
              </button>
              <button
                type="button"
                onClick={onToggleRetired}
                className="text-xs text-gray-500 underline hover:text-gray-700"
              >
                {shoe.retired ? "Remettre en service" : "Retirer"}
              </button>
              <button type="button" onClick={onDelete} className="text-xs text-red-500 underline hover:text-red-700">
                Supprimer
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function WearWithNote({ totalKm }: { totalKm: number }) {
  return (
    <div className="space-y-1">
      <WearBadge totalKm={totalKm} />
      <p className="text-[11px] font-normal text-gray-400">{WEAR_NOTE}</p>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function ShoesPage() {
  const [shoes, setShoes] = useState<Shoe[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [seeding, setSeeding] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/shoes");
      const data = await r.json();
      if (!r.ok || data.error) {
        setError(data.error ?? "Impossible de charger les paires.");
        return;
      }
      setShoes(data.shoes);
    } catch {
      setError("Impossible de charger les paires.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = shoes?.find((s) => s.id === selectedId) ?? null;

  async function handleCreate(values: ShoeFormValues) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/shoes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: values.name.trim(),
          brand: values.brand.trim() || null,
          model: values.model.trim() || null,
          dropMm: numOrNull(values.dropMm),
          stackHeelMm: numOrNull(values.stackHeelMm),
          stackForefootMm: numOrNull(values.stackForefootMm),
          weightG: numOrNull(values.weightG),
          usageType: values.usageType.trim() || null,
          imageUrl: values.imageUrl.trim() || null,
          notes: values.notes.trim() || null,
          totalKm: numOrNull(values.totalKm) ?? 0,
        }),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        setError(data.error ?? "La création a échoué.");
        return;
      }
      setShowAdd(false);
      await load();
    } catch {
      setError("La création a échoué.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdate(shoeId: string, values: ShoeFormValues) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/shoes/${shoeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: values.name.trim(),
          brand: values.brand.trim() || null,
          model: values.model.trim() || null,
          dropMm: numOrNull(values.dropMm),
          stackHeelMm: numOrNull(values.stackHeelMm),
          stackForefootMm: numOrNull(values.stackForefootMm),
          weightG: numOrNull(values.weightG),
          usageType: values.usageType.trim() || null,
          imageUrl: values.imageUrl.trim() || null,
          notes: values.notes.trim() || null,
          totalKm: numOrNull(values.totalKm) ?? 0,
        }),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        setError(data.error ?? "La mise à jour a échoué.");
        return;
      }
      await load();
    } catch {
      setError("La mise à jour a échoué.");
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleRetired(shoe: Shoe) {
    setBusy(true);
    try {
      await fetch(`/api/shoes/${shoe.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retired: !shoe.retired }),
      });
      await load();
    } catch {
      setError("La mise à jour a échoué.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(shoeId: string) {
    setBusy(true);
    try {
      const r = await fetch(`/api/shoes/${shoeId}`, {
        method: "DELETE",
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        setError(data.error ?? "La suppression a échoué.");
        return;
      }
      setSelectedId(null);
      await load();
    } catch {
      setError("La suppression a échoué.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSeed() {
    setSeeding(true);
    setError(null);
    try {
      const r = await fetch("/api/shoes/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        setError(data.error ?? "L'ajout a échoué.");
        return;
      }
      await load();
    } catch {
      setError("L'ajout a échoué.");
    } finally {
      setSeeding(false);
    }
  }

  return (
    <main className="max-w-3xl mx-auto px-4 py-12 pb-24">
      <a href="/" className="text-xs text-gray-400 hover:text-gray-600 block mb-6">
        ← Dashboard
      </a>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-xl font-semibold">L&apos;armoire</h1>
        {shoes && shoes.length > 0 && !showAdd && (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="px-3 py-1.5 text-xs font-medium text-white bg-accent rounded hover:opacity-90 transition-opacity"
          >
            + Ajouter une paire
          </button>
        )}
      </div>

      {error && <p className="text-xs text-red-500 mb-4">{error}</p>}

      {showAdd && (
        <div className="border border-gray-200 rounded-lg p-4 mb-6">
          <ShoeForm
            initial={EMPTY_FORM}
            title="Nouvelle paire"
            submitLabel="Créer"
            submitting={busy}
            onCancel={() => setShowAdd(false)}
            onSubmit={handleCreate}
          />
        </div>
      )}

      {shoes === null ? (
        <p className="text-xs text-gray-400">Chargement…</p>
      ) : shoes.length === 0 && !showAdd ? (
        <div className="border border-gray-200 rounded-lg p-6 text-center space-y-3">
          <p className="text-sm text-gray-500">Aucune paire enregistrée pour l&apos;instant.</p>
          <div className="flex items-center justify-center gap-4">
            <button
              type="button"
              disabled={seeding}
              onClick={handleSeed}
              className="px-4 py-2 text-sm font-medium text-white bg-accent rounded hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {seeding ? "Ajout…" : "Ajouter mes 3 paires"}
            </button>
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="text-xs text-gray-500 underline hover:text-gray-700"
            >
              ou ajouter une paire manuellement
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          {(shoes ?? []).map((s) => (
            <ShoeCard key={s.id} shoe={s} onClick={() => setSelectedId(s.id)} />
          ))}
        </div>
      )}

      {shoes && shoes.length > 0 && (
        <p className="text-[11px] text-gray-400 mt-6">{WEAR_NOTE}</p>
      )}

      {selected && (
        <ShoeDetail
          shoe={selected}
          saving={busy}
          onClose={() => setSelectedId(null)}
          onSave={(values) => handleUpdate(selected.id, values)}
          onDelete={() => handleDelete(selected.id)}
          onToggleRetired={() => handleToggleRetired(selected)}
        />
      )}
    </main>
  );
}
