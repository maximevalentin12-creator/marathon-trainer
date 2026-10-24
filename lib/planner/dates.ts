// Small date helpers shared across the planner. All dates are treated as UTC
// midnight to stay consistent with the rest of the app (garmin-summary,
// trends routes use the same convention) and avoid DST edge cases.

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

/** Monday of the week containing d (00:00 UTC). */
export function toMonday(d: Date): Date {
  const r = new Date(d);
  r.setUTCHours(0, 0, 0, 0);
  const day = r.getUTCDay(); // 0 = Sunday
  const offset = day === 0 ? -6 : 1 - day;
  return addDays(r, offset);
}

export function isoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

/** Parses a bare "YYYY-MM-DD" DATE column value as UTC midnight. */
export function parseIsoDate(s: string): Date {
  return new Date(s + "T00:00:00Z");
}

export function fullWeeksBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / (7 * 24 * 3600 * 1000));
}
