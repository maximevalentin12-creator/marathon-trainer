// The one French date formatter. Intl already writes weekdays and months in lowercase ("dimanche 4 avril 2027"),
// so never run its output through CSS `capitalize`.

const opts = (o: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions => ({ ...o, timeZone: "UTC" });

/** "dimanche 4 avril 2027" — spelled out, so a wrong month is obvious. */
export function fmtDateLongFr(iso: string): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString(
    "fr-FR",
    opts({ weekday: "long", day: "numeric", month: "long", year: "numeric" })
  );
}

/** "4 avr." */
export function fmtDayMonthFr(iso: string): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("fr-FR", opts({ day: "numeric", month: "short" }));
}

/** "dim. 4" */
export function fmtWeekdayDayFr(iso: string): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("fr-FR", opts({ weekday: "short", day: "numeric" }));
}
