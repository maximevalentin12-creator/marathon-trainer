// Race-plan placement rules, checked end to end: racePlan -> week resolution -> buildWeekPlan.
// Run with `npm test` (node:test through tsx).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWeekPlan } from "./rules";
import { resolveRacePlanWeek } from "./racePlanWeek";
import { heartRateZones } from "./zones";
import { addDays, parseIsoDate, toMonday } from "./dates";
import type { Race } from "./race";
import { RACE_PLAN_CONFIG } from "./config";

const DAY_MS = 86_400_000;
const zones = heartRateZones(208, 67);

interface Generated {
  date: Date;
  kind: string;
  /** A long run with marathon-pace blocks counts as quality. */
  isQuality: boolean;
  label: string;
}

const run = (date: string, km: number, paceSec = 375) => ({
  startTime: new Date(`${date}T08:00:00Z`),
  distanceKm: km,
  durationMinutes: (km * paceSec) / 60,
  activityType: "running",
});

/** A steady 3-4 runs a week, from mid-September, plus the half run on 2026-10-25. */
const activities = [
  ...["2026-09-22", "2026-09-29", "2026-10-06", "2026-10-13", "2026-10-20"].flatMap((d) => [
    run(d, 8),
    run(addDays(parseIsoDate(d), 2).toISOString().slice(0, 10), 9),
    run(addDays(parseIsoDate(d), 5).toISOString().slice(0, 10), 18),
  ]),
  run("2026-10-25", 21.1, 320),
];

const pastHalf: Race = {
  id: "past",
  name: "Semi passé",
  raceDate: parseIsoDate("2026-10-25"),
  distanceKm: 21.1,
  kind: "goal",
  resultTimeSeconds: 6750,
};

function races(goalDate: string, tuneUps: Array<{ id: string; date: string; km: number; bib?: Race["bibStatus"] }>): Race[] {
  return [
    pastHalf,
    { id: "goal", name: "Marathon", raceDate: parseIsoDate(goalDate), distanceKm: 42.195, kind: "goal", bibStatus: "pending" },
    ...tuneUps.map((t) => ({
      id: t.id,
      name: `Course ${t.id}`,
      raceDate: parseIsoDate(t.date),
      distanceKm: t.km,
      kind: "tune_up" as const,
      parentRaceId: "goal",
      bibStatus: t.bib ?? "confirmed",
    })),
  ];
}

/** Generates every week of the plan the way generateWeek does, from `today` to the goal race's week. */
function generate(allRaces: Race[], today: string, runsPerWeek = 4): Generated[] {
  const todayDate = parseIsoDate(today);
  const goal = allRaces.find((r) => r.id === "goal")!;
  const out: Generated[] = [];
  for (let weekStart = toMonday(todayDate); weekStart <= goal.raceDate; weekStart = addDays(weekStart, 7)) {
    const r = resolveRacePlanWeek({
      races: allRaces,
      weekStart,
      today: todayDate,
      activities,
      flaggedDates: [],
      easyPaceSecPerKm: 375,
    });
    assert.ok(r, `no plan week for ${weekStart.toISOString().slice(0, 10)}`);
    const calibration = {
      zones,
      paceReferenceSecPerKm: 306,
      easyPaceSecPerKm: 375,
      ...(r.paces ?? {}),
    };
    const week = buildWeekPlan({
      userId: "u",
      weekStartDate: weekStart,
      runsPerWeek,
      indoorRuns: 0,
      nonImpactSessions: 0,
      nonImpactMachines: [],
      cycleWeekNumber: 1,
      phase: "base",
      qualityLevel: r.input.qualityLevel,
      longRunMinutes: 60,
      calibration: calibration as never,
      subjectiveEntries: [],
      availableDays: [0, 1, 2, 3, 4, 5, 6],
      raceMode: r.raceMode,
      racePlan: r.input,
    });
    for (const s of week.sessions) {
      out.push({
        date: s.plannedDate,
        kind: s.kind,
        label: s.label,
        isQuality: s.kind === "threshold" || s.kind === "vo2max" || (s.kind === "long" && s.variant === "mp_blocks"),
      });
    }
  }
  return out;
}

const dayDiff = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / DAY_MS);

function assertRaceRules(sessions: Generated[], race: Race) {
  const label = `${race.name} (${race.raceDate.toISOString().slice(0, 10)})`;
  for (const s of sessions) {
    const before = dayDiff(race.raceDate, s.date); // days before the race
    const after = -before;
    if (before >= 1 && before <= 3) {
      assert.ok(!s.isQuality, `${label}: quality "${s.label}" ${before} day(s) before the race`);
    }
    if (before >= 1 && before <= 4) {
      assert.notEqual(s.kind, "long", `${label}: long run ${before} day(s) before the race`);
    }
    const easyDays = Math.ceil(race.distanceKm / 3);
    if (after >= 1 && after <= easyDays) {
      assert.ok(!s.isQuality, `${label}: quality "${s.label}" ${after} day(s) after the race (${easyDays} easy days required)`);
    }
  }
}

function assertQualityNeverNextToLong(sessions: Generated[]) {
  const longs = sessions.filter((s) => s.kind === "long");
  for (const s of sessions.filter((x) => x.isQuality && x.kind !== "long")) {
    for (const l of longs) {
      assert.notEqual(Math.abs(dayDiff(s.date, l.date)), 1, `quality "${s.label}" next to a long run (${l.date.toISOString().slice(0, 10)})`);
    }
  }
}

describe("goal marathon on a Saturday, half-marathon tune-up on a Wednesday", () => {
  const all = races("2027-04-03", [{ id: "semi", date: "2027-03-10", km: 21.1 }]);
  const sessions = generate(all, "2026-10-29");

  it("plans both races on their days", () => {
    const raceDays = sessions.filter((s) => s.kind === "race").map((s) => s.date.toISOString().slice(0, 10));
    assert.deepEqual(raceDays.sort(), ["2027-03-10", "2027-04-03"]);
  });
  it("follows the 3-day quality, 4-day long-run and easy-days rules for the goal race", () => {
    assertRaceRules(sessions, all.find((r) => r.id === "goal")!);
  });
  it("follows them for the Wednesday tune-up, including the week before it", () => {
    assertRaceRules(sessions, all.find((r) => r.id === "semi")!);
  });
  it("follows the easy-days rule after the past half", () => {
    assertRaceRules(sessions, pastHalf);
  });
  it("never puts quality the day before or after a long run", () => {
    assertQualityNeverNextToLong(sessions);
  });
  it("keeps MP blocks out of the week after the half and puts 14 km of them in week -2", () => {
    const after = sessions.filter((s) => dayDiff(s.date, parseIsoDate("2027-03-10")) > 0 && dayDiff(s.date, parseIsoDate("2027-03-10")) <= 9);
    assert.ok(after.every((s) => !s.isQuality));
    const mpLongs = sessions.filter((s) => s.kind === "long" && s.label.includes("allure marathon"));
    assert.ok(mpLongs.some((s) => s.label.includes("2 × 7 km")), "no 2 × 7 km marathon-pace long run");
  });
});

describe("goal marathon on a Saturday, half-marathon tune-up on a Sunday", () => {
  const all = races("2027-04-03", [{ id: "semi", date: "2027-03-07", km: 21.1 }]);
  const sessions = generate(all, "2026-10-29");
  const semi = parseIsoDate("2027-03-07");

  it("makes the week after easy only, with one easy long run of at most 2 h from day 6", () => {
    const week = sessions.filter((s) => dayDiff(s.date, semi) >= 1 && dayDiff(s.date, semi) <= 7);
    assert.ok(week.every((s) => !s.isQuality), "quality in the week after the half");
    const longs = week.filter((s) => s.kind === "long");
    assert.ok(longs.length <= 1);
    for (const l of longs) {
      assert.ok(dayDiff(l.date, semi) >= 6, "long run before day 6");
      assert.ok(!l.label.includes("allure marathon"), "MP block in the week after the half");
    }
  });
  it("puts the last peak (14 km at MP) in week -2 and an earlier 12 km one in week -5", () => {
    const mp = sessions.filter((s) => s.kind === "long" && s.label.includes("allure marathon")).map((s) => s.label);
    assert.ok(mp.some((l) => l.includes("2 × 7 km")), "no 2 × 7 km block");
    assert.ok(mp.some((l) => l.includes("2 × 6 km")), "no 2 × 6 km block");
  });
  it("follows the race rules", () => {
    assertRaceRules(sessions, all.find((r) => r.id === "goal")!);
    assertRaceRules(sessions, all.find((r) => r.id === "semi")!);
    assertQualityNeverNextToLong(sessions);
  });
});

describe("goal marathon on a Saturday, 10 km tune-up on a Wednesday", () => {
  const all = races("2027-04-03", [{ id: "tt", date: "2027-02-17", km: 10, bib: "solo_test" }]);
  const sessions = generate(all, "2026-10-29");

  it("follows the rules for both races", () => {
    assertRaceRules(sessions, all.find((r) => r.id === "goal")!);
    assertRaceRules(sessions, all.find((r) => r.id === "tt")!);
  });
  it("never puts quality next to a long run", () => {
    assertQualityNeverNextToLong(sessions);
  });
});

describe("5 runs a week", () => {
  it("still respects the race rules", () => {
    const all = races("2027-04-03", [{ id: "semi", date: "2027-03-10", km: 21.1 }]);
    const sessions = generate(all, "2026-10-29", 5);
    assertRaceRules(sessions, all.find((r) => r.id === "goal")!);
    assertRaceRules(sessions, all.find((r) => r.id === "semi")!);
    assertQualityNeverNextToLong(sessions);
  });
});

describe("quality next to the long run", () => {
  const base = {
    userId: "u",
    weekStartDate: parseIsoDate("2026-11-30"),
    runsPerWeek: 3,
    indoorRuns: 0,
    nonImpactSessions: 0,
    nonImpactMachines: [],
    cycleWeekNumber: 1,
    phase: "base" as const,
    qualityLevel: 1,
    longRunMinutes: 90,
    calibration: { zones, paceReferenceSecPerKm: 306, easyPaceSecPerKm: 375 },
    subjectiveEntries: [],
    racePlan: {
      phase: "base" as const,
      targetKm: 40,
      longRunMin: 120,
      keySession: "threshold" as const,
      isDeload: false,
      longRunMpBlock: null,
      qualityFromDay: 0,
      qualityLevel: 1,
    },
  };

  it("moves the quality session off the long run's neighbours when the available days allow it", () => {
    const week = buildWeekPlan({ ...base, availableDays: [2, 3, 4, 5] });
    const long = week.sessions.find((s) => s.kind === "long")!;
    const quality = week.sessions.find((s) => s.kind === "threshold")!;
    assert.ok(quality, "quality session kept");
    assert.notEqual(Math.abs(dayDiff(quality.plannedDate, long.plannedDate)), 1);
  });

  it("downgrades it to easy + strides, with a French note, when they don't", () => {
    // Fri / Sat / Sun with the long run on Saturday: both other days touch it.
    const week = buildWeekPlan({ ...base, availableDays: [4, 5, 6] });
    assert.ok(!week.sessions.some((s) => s.kind === "threshold"), "quality kept next to the long run");
    const easy = week.sessions.find((s) => s.downgradedFrom === "threshold")!;
    assert.ok(easy, "no downgraded session");
    assert.equal(easy.kind, "easy");
    assert.equal(easy.stridesAdded, true);
    assert.match(easy.downgradeReason ?? "", /veille ou le lendemain de la sortie longue/);
  });
});

describe("config", () => {
  it("keeps the race week at or under half the peak", () => {
    for (const share of Object.values(RACE_PLAN_CONFIG.raceWeekVolumeShare)) assert.ok(share <= 0.5);
  });
});
