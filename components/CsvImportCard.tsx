"use client";

import { useEffect, useRef, useState } from "react";

interface ImportResult {
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
  matched: number;
  reevaluated: number;
}

type Status = "idle" | "uploading" | "done" | "error";

export default function CsvImportCard() {
  const [userId, setUserId] = useState<string | null | undefined>(undefined);
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setUserId(localStorage.getItem("marathon_user_id"));
  }, []);

  async function uploadFile(file: File) {
    if (!userId) return;
    setStatus("uploading");
    setError(null);
    setResult(null);

    try {
      const body = new FormData();
      body.append("file", file);
      body.append("userId", userId);

      const res = await fetch("/api/import/csv", { method: "POST", body });
      const json = await res.json();

      if (!res.ok) {
        setError(json.error ?? "Import failed");
        setStatus("error");
        return;
      }

      setResult(json);
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (file) uploadFile(file);
  }

  if (userId === undefined) return null;

  if (!userId) {
    return (
      <p className="text-xs text-gray-500">
        <a href="/onboarding" className="underline">
          Complete onboarding
        </a>{" "}
        first to link a CSV import to your profile.
      </p>
    );
  }

  return (
    <div>
      <p className="text-xs text-gray-500 mb-3">
        Exporte depuis connect.garmin.com → Activités → Exporter CSV, puis glisse le fichier ici.
      </p>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={`border border-dashed rounded-lg p-4 text-center text-xs cursor-pointer transition-colors ${
          dragOver ? "border-accent bg-accent/5 text-accent" : "border-gray-300 text-gray-500 hover:border-gray-400"
        }`}
      >
        {status === "uploading" ? (
          "Import en cours…"
        ) : (
          <>
            Glisse ton fichier CSV ici, ou clique pour le sélectionner
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
          </>
        )}
      </div>

      {status === "done" && result && (
        <div className="mt-3 text-xs text-gray-600 space-y-0.5">
          <p>
            <span className="font-medium text-gray-800">{result.inserted}</span> importées ·{" "}
            <span className="font-medium text-gray-800">{result.updated}</span> mises à jour ·{" "}
            <span className="font-medium text-gray-800">{result.skipped}</span> ignorées ·{" "}
            <span className="font-medium text-gray-800">{result.errors}</span> erreurs ·{" "}
            <span className="font-medium text-gray-800">{result.matched}</span> séances liées ·{" "}
            <span className="font-medium text-gray-800">{result.reevaluated}</span> réévaluées
          </p>
        </div>
      )}

      {status === "error" && error && <p className="mt-3 text-xs text-red-600">{error}</p>}
    </div>
  );
}
