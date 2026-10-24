// Parses a Garmin Connect "Export CSV" (Activities → Export CSV) into rows
// shaped for the garmin_activities table. Garmin exports in French by
// default; English column names are supported as a fallback.

export interface ParsedActivity {
  activityType: string;
  /** "YYYY-MM-DD HH:MM:SS", naive local time — same shape scripts/sync_garmin.py stores. */
  startTime: string;
  title: string;
  distanceMeters: number;
  durationSeconds: number | null;
  avgPaceSecPerKm: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  avgCadence: number | null;
  maxCadence: number | null;
  avgGroundContactMs: number | null;
  avgVerticalOscillation: number | null;
  avgStrideLength: number | null;
  aerobicTe: number | null;
  bestPaceSecPerKm: number | null;
  totalAscentM: number | null;
  gapPaceSecPerKm: number | null;
  raw: Record<string, string>;
}

export interface ParseCsvResult {
  activities: ParsedActivity[];
  skipped: number;
}

const COLUMN_ALIASES: Record<string, string[]> = {
  activityType: ["Type d'activité", "Activity Type"],
  date: ["Date", "Date"],
  title: ["Titre", "Title"],
  distance: ["Distance", "Distance"],
  duration: ["Durée", "Time"],
  avgHr: ["Fréquence cardiaque moyenne", "Avg HR"],
  avgPace: ["Allure moyenne", "Avg Pace"],
  maxHr: ["Fréquence cardiaque maximale", "Max HR"],
  avgCadence: ["Cadence de course moyenne", "Avg Run Cadence"],
  maxCadence: ["Cadence de course maximale", "Max Run Cadence"],
  avgGroundContact: ["Temps de contact moyen avec le sol", "Avg Ground Contact Time"],
  avgVerticalOscillation: ["Oscillation verticale moyenne", "Avg Vertical Oscillation"],
  avgStrideLength: ["Longueur moyenne des foulées", "Avg Stride Length"],
  aerobicTe: ["TE aérobie", "Aerobic TE"],
  bestPace: ["Meilleure allure", "Best Pace"],
  totalAscent: ["Ascension totale", "Total Ascent"],
  gapPace: ["GAP moyenne", "Avg GAP"],
};

/** Splits raw CSV text into rows of string cells, handling quoted fields (commas, embedded quotes, newlines). */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  // Strip a leading BOM, which Garmin's export includes.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // skip; \n (handled below) terminates the row
    } else if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  // Flush a trailing field/row that wasn't newline-terminated.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

/**
 * Parses a Garmin numeric cell as an integer. "--" (Garmin's placeholder for
 * missing data) and empty cells are null. Tolerant of a decimal comma and
 * thousands separators (space/non-breaking space), since French exports use
 * "," for decimals and sometimes " " to group thousands.
 */
function parseIntCell(raw: string): number | null {
  const s = raw.trim();
  if (!s || s === "--") return null;
  const n = parseFloat(s.replace(/\s/g, "").replace(",", "."));
  return isFinite(n) ? Math.round(n) : null;
}

/** Same as parseIntCell but keeps the fractional value (vertical oscillation in cm, stride length in m, TE). */
function parseFloatCell(raw: string): number | null {
  const s = raw.trim();
  if (!s || s === "--") return null;
  const n = parseFloat(s.replace(/\s/g, "").replace(",", "."));
  return isFinite(n) ? n : null;
}

/** "H:MM:SS" or "MM:SS" or "SS" → total seconds. */
function parseClockToSeconds(s: string): number | null {
  const parts = s.trim().split(":").map(Number);
  if (parts.length === 0 || parts.some((n) => isNaN(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

/** Like parseClockToSeconds, but a missing/empty cell or "--" is null rather than 0 — for columns that may not exist in every export. */
function parseClockCell(raw: string): number | null {
  const s = raw.trim();
  if (!s || s === "--") return null;
  return parseClockToSeconds(s);
}

/**
 * Garmin's activityType.typeKey equivalents used by lib/planner/completion.ts's
 * matcher — including the non-impact modalities (vélo/assault bike → cycling,
 * élliptique → elliptical) so a non-impact planned session can auto-complete
 * too, gated on modality just like running is.
 */
function normalizeActivityType(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (v.includes("tapis") || v.includes("treadmill")) return "treadmill_running";
  if (v.includes("course à pied") || v.includes("running")) return "running";
  if (v.includes("vélo") || v.includes("velo") || v.includes("cycl") || v.includes("bike")) return "cycling";
  if (v.includes("elliptique") || v.includes("élliptique") || v.includes("elliptical")) return "elliptical";
  return raw.trim();
}

export function parseGarminCsv(text: string): ParseCsvResult {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return { activities: [], skipped: 0 };

  const header = rows[0].map((h) => h.trim());
  const columnIndex: Partial<Record<keyof typeof COLUMN_ALIASES, number>> = {};

  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
    const idx = header.findIndex((h) => aliases.includes(h));
    if (idx !== -1) columnIndex[canonical as keyof typeof COLUMN_ALIASES] = idx;
  }

  if (columnIndex.date === undefined || columnIndex.distance === undefined) {
    throw new Error(
      "Unrecognized CSV format: could not find 'Date'/'Distance' (or 'Date'/'Distance') columns."
    );
  }

  const activities: ParsedActivity[] = [];
  let skipped = 0;

  for (const cells of rows.slice(1)) {
    if (cells.every((c) => c.trim() === "")) continue;

    const get = (key: keyof typeof COLUMN_ALIASES): string => {
      const idx = columnIndex[key];
      return idx === undefined ? "" : (cells[idx] ?? "").trim();
    };

    const dateStr = get("date");
    const distanceStr = get("distance").replace(",", ".");
    const distanceKm = parseFloat(distanceStr);

    if (!dateStr || !isFinite(distanceKm) || distanceKm <= 0) {
      skipped++;
      continue;
    }

    const durationSeconds = parseClockToSeconds(get("duration"));
    const avgPaceSecPerKm = parseClockToSeconds(get("avgPace"));
    const avgHrRaw = get("avgHr");
    const avgHeartRate = avgHrRaw ? parseInt(avgHrRaw, 10) : null;

    const raw: Record<string, string> = {};
    header.forEach((h, i) => (raw[h] = cells[i] ?? ""));

    activities.push({
      activityType: normalizeActivityType(get("activityType") || "running"),
      startTime: dateStr,
      title: get("title"),
      distanceMeters: distanceKm * 1000,
      durationSeconds,
      avgPaceSecPerKm:
        avgPaceSecPerKm ?? (durationSeconds ? Math.round(durationSeconds / distanceKm) : null),
      avgHeartRate: avgHeartRate !== null && !isNaN(avgHeartRate) ? avgHeartRate : null,
      maxHeartRate: parseIntCell(get("maxHr")),
      avgCadence: parseIntCell(get("avgCadence")),
      maxCadence: parseIntCell(get("maxCadence")),
      avgGroundContactMs: parseIntCell(get("avgGroundContact")),
      avgVerticalOscillation: parseFloatCell(get("avgVerticalOscillation")),
      avgStrideLength: parseFloatCell(get("avgStrideLength")),
      aerobicTe: parseFloatCell(get("aerobicTe")),
      bestPaceSecPerKm: parseClockCell(get("bestPace")),
      totalAscentM: parseIntCell(get("totalAscent")),
      gapPaceSecPerKm: parseClockCell(get("gapPace")),
      raw,
    });
  }

  return { activities, skipped };
}

const FNV_OFFSET_BASIS = BigInt("0xcbf29ce484222325");
const FNV_PRIME = BigInt("0x100000001b3");
const HASH_64_MASK = (BigInt(1) << BigInt(64)) - BigInt(1);
// Keep the synthetic id within Number.MAX_SAFE_INTEGER so it survives JSON/JS
// round-tripping without precision loss (51 bits ≈ 2.25e15 distinct values,
// far more than any personal activity history needs).
const SAFE_ID_MASK = (BigInt(1) << BigInt(51)) - BigInt(1);

/** Deterministic synthetic garmin_activity_id, used when a CSV row has no native Garmin id. */
export function syntheticActivityId(dateStr: string, distanceKey: string): number {
  let hash = FNV_OFFSET_BASIS;
  const input = `${dateStr}|${distanceKey}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV_PRIME) & HASH_64_MASK;
  }
  return Number(hash & SAFE_ID_MASK);
}
