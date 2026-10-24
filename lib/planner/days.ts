// Weekday codes used for weekly_setups.available_days and for the manual
// per-session day-override plumbing. Offset is days-from-Monday (0=Mon..
// 6=Sun), matching how buildWeekPlan already turns weekStartDate (always a
// Monday) + an offset into a planned_date via addDays().

export const DAY_CODES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DayCode = (typeof DAY_CODES)[number];

export const DAY_LABELS_FR: Record<DayCode, string> = {
  mon: "Lun",
  tue: "Mar",
  wed: "Mer",
  thu: "Jeu",
  fri: "Ven",
  sat: "Sam",
  sun: "Dim",
};

export const ALL_DAY_CODES: readonly DayCode[] = DAY_CODES;

export function dayCodeToOffset(code: DayCode): number {
  return DAY_CODES.indexOf(code);
}

export function offsetToDayCode(offset: number): DayCode {
  return DAY_CODES[offset];
}

export function isDayCode(value: unknown): value is DayCode {
  return typeof value === "string" && (DAY_CODES as readonly string[]).includes(value);
}
