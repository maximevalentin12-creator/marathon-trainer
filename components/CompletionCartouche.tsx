/**
 * Post-session evaluation cartouche (score, note, completion_analysis bullets)
 * for a completed planned session — see evaluateCompletion() in
 * lib/planner/completion.ts. Shared by WeeklyPlanCard and /historique.
 * A race has no score: pass `result` and the cartouche shows "Résultat" with
 * its time, distance, pace and average HR instead.
 */

export interface RaceResult {
  durationSeconds: number | null;
  distanceKm: number | null;
  avgPaceSecPerKm: number | null;
  avgHeartRate: number | null;
}

function fmtTime(totalSeconds: number): string {
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h} h ${m} min ${sec} s` : `${Number(m)} min ${sec} s`;
}

function fmtPace(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = String(Math.round(sec % 60)).padStart(2, "0");
  return `${m}:${s}/km`;
}

function ResultCartouche({ result }: { result: RaceResult }) {
  const items = [
    result.durationSeconds != null ? fmtTime(result.durationSeconds) : null,
    result.distanceKm != null ? `${result.distanceKm.toLocaleString("fr-FR")} km` : null,
    result.avgPaceSecPerKm != null ? fmtPace(result.avgPaceSecPerKm) : null,
    result.avgHeartRate != null ? `FC moy. ${Math.round(result.avgHeartRate)} bpm` : null,
  ].filter((v): v is string => v != null);

  return (
    <div className="rounded-md border border-green-200 bg-green-50 px-2.5 py-1.5">
      <div className="flex items-start gap-2 flex-wrap">
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-green-700 bg-white border border-green-200 rounded px-1.5 py-0.5">
          Résultat
        </span>
        {items.map((item, i) => (
          <span key={i} className={`text-xs text-green-800 tabular-nums${i === 0 ? " font-semibold" : ""}`}>
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function CompletionCartouche({
  score,
  note,
  analysis,
  result = null,
}: {
  score: number | null;
  note: string | null;
  analysis: string[] | null;
  /** Set for a race: replaces the score with the race's result. */
  result?: RaceResult | null;
}) {
  if (result) return <ResultCartouche result={result} />;

  return (
    <div className="rounded-md border border-green-200 bg-green-50 px-2.5 py-1.5">
      <div className="flex items-start gap-2">
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-green-700 bg-white border border-green-200 rounded px-1.5 py-0.5">
          ✓ Complétée
        </span>
        {score != null && (
          <span className="shrink-0 text-xs font-semibold text-green-800 tabular-nums">{score}%</span>
        )}
        {note && <span className="text-xs text-green-700">{note}</span>}
      </div>
      {analysis && analysis.length > 0 && (
        <ul className="mt-1.5 pl-4 space-y-0.5 list-disc marker:text-green-400">
          {analysis.map((line, i) => (
            <li key={i} className="text-[11px] text-green-800">
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
