"use client";

import { useCallback, useEffect, useState } from "react";
import { heartRateZones, type EffortZone, type EffortZoneId } from "@/lib/planner";
import { HR_MAX_RANGE, HR_REST_RANGE, HR_SOURCE_LABEL_FR, type HrSource } from "@/lib/athlete/profile";

interface ProfileResponse {
  profile: {
    hrMax: number;
    hrMaxSource: HrSource;
    hrMaxUpdatedAt: string | null;
    hrRest: number;
    hrRestSource: HrSource;
    stored: boolean;
  };
  zones: Record<EffortZoneId, EffortZone>;
  paceReferenceSecPerKm: number;
  easyPace: {
    secPerKm: number;
    source: "runs" | "formula";
    runCount: number;
    targetBpm: number | null;
    fallbackReason: string | null;
    formulaSecPerKm: number;
    minRuns: number;
    windowDays: number;
  };
}

function fmtPace(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = String(Math.round(sec % 60)).padStart(2, "0");
  return `${m}:${s}/km`;
}

function SourceBadge({ source }: { source: HrSource }) {
  return (
    <span className="inline-block whitespace-nowrap text-[10px] uppercase tracking-wide border border-gray-200 rounded px-1.5 py-0.5 text-gray-500">
      {HR_SOURCE_LABEL_FR[source]}
    </span>
  );
}

function ZonesTable({ zones }: { zones: Record<EffortZoneId, EffortZone> }) {
  return (
    <table className="w-full text-xs">
      <tbody>
        {Object.values(zones).map((z) => (
          <tr key={z.id} className="border-t border-gray-100 align-top">
            <td className="py-1.5 pr-3 w-24 text-gray-700">{z.label}</td>
            <td className="py-1.5 pr-3 w-24 tabular-nums text-gray-600 whitespace-nowrap">
              {z.bpmMin}–{z.bpmMax} bpm
            </td>
            <td className="py-1.5 text-gray-500">{z.feeling}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function ProfilPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "no-user">("loading");
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [hrMax, setHrMax] = useState("");
  const [hrRest, setHrRest] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/profile?userId=${encodeURIComponent(id)}`);
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? "Erreur");
      setData(json);
      setHrMax(String(json.profile.hrMax));
      setHrRest(String(json.profile.hrRest));
    } catch {
      setError("Impossible de charger le profil.");
    }
  }, []);

  useEffect(() => {
    const id = localStorage.getItem("marathon_user_id");
    if (!id) {
      setPhase("no-user");
      return;
    }
    setUserId(id);
    void load(id).then(() => setPhase("ready"));
  }, [load]);

  const maxNum = Number(hrMax);
  const restNum = Number(hrRest);
  const inputsValid =
    Number.isInteger(maxNum) &&
    Number.isInteger(restNum) &&
    maxNum >= HR_MAX_RANGE.min &&
    maxNum <= HR_MAX_RANGE.max &&
    restNum >= HR_REST_RANGE.min &&
    restNum <= HR_REST_RANGE.max &&
    maxNum - restNum >= 60;
  const dirty = data != null && (maxNum !== data.profile.hrMax || restNum !== data.profile.hrRest);
  const previewZones = inputsValid ? heartRateZones(maxNum, restNum) : data?.zones;

  async function handleSave() {
    if (!userId || !inputsValid) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const r = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, hrMax: maxNum, hrRest: restNum }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? "Erreur");
      setMessage(
        json.changed
          ? `Enregistré (test terrain). ${json.reevaluated} séance(s) réalisée(s) réévaluée(s) avec les nouvelles zones.`
          : "Aucun changement."
      );
      await load(userId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur à l'enregistrement.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="max-w-3xl mx-auto px-4 py-12 pb-24">
      <a href="/" className="text-xs text-gray-400 hover:text-gray-600 block mb-6">
        ← Dashboard
      </a>
      <header className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">Profil</h1>
        <p className="mt-1 text-sm text-gray-500">
          Ta FC max et ta FC repos calibrent toutes les zones du plan (méthode de Karvonen, en % de la fréquence
          cardiaque de réserve) et l&apos;évaluation de tes séances.
        </p>
      </header>

      {phase === "no-user" && (
        <p className="text-xs text-gray-500">
          <a href="/onboarding" className="underline">
            Complète ton profil
          </a>{" "}
          d&apos;abord.
        </p>
      )}
      {phase === "loading" && <p className="text-xs text-gray-400">Chargement…</p>}
      {error && <p className="text-xs text-red-600 mb-4">{error}</p>}

      {phase === "ready" && data && (
        <div className="space-y-8">
          {!data.profile.stored && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
              Valeurs par défaut : la migration « athlete profile » de supabase/schema.sql n&apos;est pas encore
              appliquée, l&apos;enregistrement est indisponible.
            </p>
          )}

          <section>
            <h2 className="text-sm font-medium text-gray-700 mb-3">Fréquences cardiaques</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="block">
                <span className="flex items-center gap-2 text-xs text-gray-600 mb-1">
                  FC max <SourceBadge source={data.profile.hrMaxSource} />
                </span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={HR_MAX_RANGE.min}
                  max={HR_MAX_RANGE.max}
                  value={hrMax}
                  onChange={(e) => setHrMax(e.target.value)}
                  className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm tabular-nums"
                />
              </label>
              <label className="block">
                <span className="flex items-center gap-2 text-xs text-gray-600 mb-1">
                  FC repos <SourceBadge source={data.profile.hrRestSource} />
                </span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={HR_REST_RANGE.min}
                  max={HR_REST_RANGE.max}
                  value={hrRest}
                  onChange={(e) => setHrRest(e.target.value)}
                  className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm tabular-nums"
                />
              </label>
            </div>
            <p className="mt-2 text-[11px] text-gray-400">
              Une valeur modifiée ici est enregistrée comme « test terrain » et prime sur les réglages Garmin. La FC max
              remonte aussi automatiquement si une séance enregistre plus haut — jamais vers le bas.
            </p>
            {!inputsValid && (
              <p className="mt-2 text-xs text-red-600">
                FC max entre {HR_MAX_RANGE.min} et {HR_MAX_RANGE.max}, FC repos entre {HR_REST_RANGE.min} et{" "}
                {HR_REST_RANGE.max}, au moins 60 bpm d&apos;écart.
              </p>
            )}
            <button
              onClick={handleSave}
              disabled={!dirty || !inputsValid || saving || !data.profile.stored}
              className="mt-3 px-3 py-1.5 text-xs font-medium text-white bg-accent rounded hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              {saving ? "Enregistrement…" : "Enregistrer"}
            </button>
            {message && <p className="mt-2 text-xs text-green-700">{message}</p>}
          </section>

          <section>
            <h2 className="text-sm font-medium text-gray-700 mb-1">Zones</h2>
            {dirty && inputsValid && (
              <p className="text-[11px] text-amber-600 mb-2">Aperçu avec les valeurs saisies (non enregistrées).</p>
            )}
            {previewZones && <ZonesTable zones={previewZones} />}
            <p className="mt-2 text-[11px] text-gray-400">
              Les séances déjà planifiées gardent leurs repères bpm jusqu&apos;à la prochaine régénération de la
              semaine.
            </p>
          </section>

          <section>
            <h2 className="text-sm font-medium text-gray-700 mb-2">Allure facile</h2>
            <p className="text-sm">
              <span className="font-medium tabular-nums">{fmtPace(data.easyPace.secPerKm)}</span>{" "}
              {data.easyPace.source === "runs" ? (
                <span className="text-xs text-gray-500">
                  estimée sur {data.easyPace.runCount} sortie(s) facile(s)/longue(s) en extérieur des{" "}
                  {Math.round(data.easyPace.windowDays / 7)} dernières semaines, lue à {data.easyPace.targetBpm} bpm
                  (haut de la zone Facile).
                </span>
              ) : (
                <span className="text-xs text-gray-500">
                  formule (allure de référence 10 km {fmtPace(data.paceReferenceSecPerKm)} × 1,29) —{" "}
                  {data.easyPace.fallbackReason} ({data.easyPace.runCount} sortie(s) exploitable(s), il en faut au
                  moins {data.easyPace.minRuns}).
                </span>
              )}
            </p>
            {data.easyPace.source === "runs" && (
              <p className="mt-1 text-[11px] text-gray-400">
                Pour comparaison, la formule donnerait {fmtPace(data.easyPace.formulaSecPerKm)}. Le tapis est exclu
                (allure poignet peu fiable).
              </p>
            )}
          </section>

          <section>
            <h2 className="text-sm font-medium text-gray-700 mb-2">Mesurer ta FC max sur le terrain</h2>
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mb-3">
              Uniquement en bonne santé et reposé (pas de séance dure la veille), idéalement pas seul. Arrête
              immédiatement en cas de douleur dans la poitrine, de vertige ou de malaise.
            </p>
            <ol className="list-decimal list-inside text-xs text-gray-600 space-y-1.5">
              <li>Ceinture cardio de préférence : le capteur au poignet décroche souvent sur les efforts brefs.</li>
              <li>Échauffement complet : 15–20 min facile, puis 3–4 accélérations progressives de 20 s.</li>
              <li>3 min dur, à un effort que tu ne tiendrais pas beaucoup plus longtemps.</li>
              <li>
                Sans pause, enchaîne sur une côte : 2 min à fond, en finissant en sprint sur les 20–30 dernières
                secondes.
              </li>
              <li>Relève la FC la plus haute atteinte, puis retour au calme 10–15 min en marchant ou trottinant.</li>
              <li>Saisis la valeur ci-dessus : elle remplace la valeur Garmin.</li>
            </ol>
            <p className="mt-3 text-[11px] text-gray-400">
              FC repos : mesure-la au réveil, allongé, avant de te lever, plusieurs matins de suite, et garde la valeur
              habituelle.
            </p>
          </section>
        </div>
      )}
    </main>
  );
}
