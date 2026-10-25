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
import { buildRacePlan, type PlanRace } from "./racePlan";
import { isRaceActivity } from "./racePlanWeek";

const DAY_MS = 86_400_000;
const zones = heartRateZones(208, 67);

interface Generated {
  date: Date;
  kind: string;
  /** A long run with marathon-pace blocks counts as quality. */
  isQuality: boolean;
  label: string;
  minutes: number;
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
        minutes: s.targetDurationMinutes,
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

// ── Plan-level numbers: anchor, long-run cap, race-week volumes ─────────────

const planGoal: PlanRace = { id: "goal", name: "Marathon", raceDate: parseIsoDate("2027-04-04"), distanceKm: 42.195, bibStatus: "pending" };
const planTuneUps: PlanRace[] = [
  { id: "semi", name: "Semi", raceDate: parseIsoDate("2027-03-07"), distanceKm: 21.1, bibStatus: "pending" },
  { id: "10k", name: "10K test", raceDate: parseIsoDate("2027-02-21"), distanceKm: 10, bibStatus: "solo_test" },
];
const planHistory = (extra: Array<ReturnType<typeof run> & { isRace?: boolean }> = []) => ({
  today: parseIsoDate("2026-10-24"),
  activities: [...activities, ...extra],
  lastRace: { raceDate: parseIsoDate("2026-10-18"), distanceKm: 21.45 },
  easyPaceSecPerKm: 375,
});

describe("long-run anchor", () => {
  it("ignores races, and resumes at 90% of it after the recovery weeks", () => {
    const race = { ...run("2026-10-18", 21.45, 320), isRace: true, durationMinutes: 200 };
    const withRace = buildRacePlan(planGoal, planTuneUps, planHistory([race]));
    const without = buildRacePlan(planGoal, planTuneUps, planHistory());
    assert.equal(withRace.longRunAnchorMin, without.longRunAnchorMin);
    const firstLoad = withRace.weeks.find((w) => w.phase !== "recovery")!;
    assert.ok(firstLoad.longRunMin <= Math.round((withRace.longRunAnchorMin * 0.9) / 5) * 5);
  });
  it("recognises a race activity by Garmin flag or by races row", () => {
    const races: Race[] = [{ id: "r", name: "R", raceDate: parseIsoDate("2026-10-18"), distanceKm: 21.1 }];
    assert.ok(isRaceActivity({ startTime: new Date("2026-10-18T08:00:00Z"), distanceKm: 21.4 }, races));
    assert.ok(isRaceActivity({ startTime: new Date("2026-09-01T08:00:00Z"), distanceKm: 10, eventType: "race" }, []));
    assert.ok(!isRaceActivity({ startTime: new Date("2026-10-18T08:00:00Z"), distanceKm: 8 }, races));
  });
});

describe("long run share of the week", () => {
  it("never exceeds 40% in base/development and 45% in specific, without changing the week's km", () => {
    const plan = buildRacePlan(planGoal, planTuneUps, planHistory());
    for (const w of plan.weeks) {
      if (!["base", "development", "specific"].includes(w.phase) || w.longRunMin === 0) continue;
      const share = RACE_PLAN_CONFIG.longRunMaxShareOfWeek[w.phase as "base" | "development" | "specific"];
      const longKm = (w.longRunMin * 60) / 375;
      assert.ok(longKm <= share * w.targetKm + (5 * 60) / 375, `week ${w.weekStart.toISOString().slice(0, 10)}: long ${longKm.toFixed(1)} km of ${w.targetKm}`);
    }
  });
});

describe("race-week volumes", () => {
  const plan = buildRacePlan(planGoal, planTuneUps, planHistory());
  const week = (n: number) => plan.weeks.find((w) => w.weeksToRace === n)!;

  it("plans the half tune-up week at ~70% and the 10K week at ~85% of the previous full week, race included", () => {
    assert.ok(Math.abs(week(4).targetKm - 0.7 * week(5).targetKm) <= 1, `${week(4).targetKm} vs ${week(5).targetKm}`);
    assert.ok(Math.abs(week(6).targetKm - 0.85 * week(7).targetKm) <= 1, `${week(6).targetKm} vs ${week(7).targetKm}`);
    assert.equal(week(4).raceKm, 21.1);
  });
  it("keeps the week after the half to 70% of the last full week, easy only", () => {
    assert.ok(week(3).targetKm <= Math.round(0.7 * week(5).targetKm));
    assert.equal(week(3).keySession, "none");
    assert.ok(week(3).longRunMin <= 120);
  });
  it("keeps marathon week -2 at 85% of the peak, the long run its only quality", () => {
    const peak = plan.peakKm;
    assert.ok(week(2).targetKm <= Math.round(0.85 * peak));
    assert.equal(week(2).keySession, "strides");
    const mp = week(2).longRunMpBlock!;
    assert.equal(mp.reps * mp.kmEach, 14);
  });
  it("lands the peak volume in the specific phase before the half tune-up", () => {
    const peakWeek = plan.weeks.find((w) => w.targetKm === plan.peakKm && w.raceIds.length === 0)!;
    assert.equal(peakWeek.phase, "specific");
    assert.ok(peakWeek.weeksToRace > week(4).weeksToRace);
  });
  it("makes the race week the 2nd taper week, at most half the peak, and week -1 ≈ 70%", () => {
    assert.ok(week(0).targetKm <= 0.5 * plan.peakKm);
    assert.ok(Math.abs(week(1).targetKm - 0.7 * plan.peakKm) <= 1);
  });
});

describe("continuous mode", () => {
  it("also keeps quality off the long run's neighbouring days", () => {
    for (const runs of [3, 4, 5]) {
      const week = buildWeekPlan({
        userId: "u",
        weekStartDate: parseIsoDate("2026-11-02"),
        runsPerWeek: runs,
        indoorRuns: 0,
        nonImpactSessions: 0,
        nonImpactMachines: [],
        cycleWeekNumber: 1,
        phase: "base",
        qualityLevel: 2,
        longRunMinutes: 90,
        calibration: { zones, paceReferenceSecPerKm: 306, easyPaceSecPerKm: 375 },
        subjectiveEntries: [],
        availableDays: [0, 1, 2, 3, 4, 5, 6],
      });
      const long = week.sessions.find((x) => x.kind === "long")!;
      for (const q of week.sessions.filter((x) => x.kind === "threshold" || x.kind === "vo2max")) {
        assert.notEqual(Math.abs(dayDiff(q.plannedDate, long.plannedDate)), 1, `${runs} runs: quality next to the long run`);
      }
    }
  });
});

describe("floors", () => {
  const plan = buildRacePlan(planGoal, planTuneUps, planHistory());
  it("keeps long runs at 60 / 90 / 120 min or more outside tune-up, recovery, taper and race weeks", () => {
    for (const w of plan.weeks) {
      if (!["base", "development", "specific"].includes(w.phase) || w.raceIds.length > 0 || w.longRunMin === 0) continue;
      const floor = RACE_PLAN_CONFIG.longRunFloorMin[w.phase as "base" | "development" | "specific"];
      assert.ok(w.longRunMin >= floor, `${w.weekStart.toISOString().slice(0, 10)} (${w.phase}): ${w.longRunMin} < ${floor}`);
    }
  });
  it("warns instead of cutting when a floor pushes a week past its km", () => {
    const small = buildRacePlan(planGoal, planTuneUps, {
      ...planHistory(),
      activities: [run("2026-10-06", 5), run("2026-10-13", 5), run("2026-09-29", 5), run("2026-09-22", 5)],
    });
    assert.ok(small.warnings.some((x) => x.includes("planchers")));
  });
  it("never plans an easy run under 30 minutes", () => {
    const sessions = generate(races("2027-04-03", []), "2026-10-29");
    for (const s of sessions.filter((x) => x.kind === "easy")) {
      assert.ok(s.minutes >= 30 || s.label.includes("rappels") || s.label.includes("adaptée"), `${s.label}: ${s.minutes} min`);
    }
  });
});

describe("marathon pace in the long run", () => {
  const plan = buildRacePlan(planGoal, planTuneUps, { ...planHistory(), marathonPaceSecPerKm: 344 });
  const mp = (n: number) => {
    const b = plan.weeks.find((w) => w.weeksToRace === n)!.longRunMpBlock;
    return b ? b.reps * b.kmEach : 0;
  };
  it("finishes the development long runs with 3 → 5 → 6 km from 10 weeks out, none on deload weeks", () => {
    assert.deepEqual([mp(10), mp(9), mp(8), mp(7)], [3, 5, 0, 6]);
    assert.equal(mp(11), 0);
    assert.equal(plan.weeks.find((w) => w.weeksToRace === 10)!.longRunMpBlock!.finish, true);
  });
  it("keeps the specific blocks: 12 km at -5, 14 km at -2", () => {
    assert.equal(mp(5), 12);
    assert.equal(mp(2), 14);
  });
  it("shrinks a block that doesn't fit (MP km × pace + 30 min easy ≤ long run) and warns", () => {
    const slow = buildRacePlan(planGoal, planTuneUps, { ...planHistory(), marathonPaceSecPerKm: 600 });
    for (const w of slow.weeks) {
      const b = w.longRunMpBlock;
      if (b) assert.ok(((b.reps * b.kmEach * 600) / 60) + 30 <= w.longRunMin, `${w.weekStart.toISOString().slice(0, 10)}`);
    }
    assert.ok(slow.warnings.some((x) => x.includes("ne tiennent pas")));
  });
  it("shrinks it in the session too", () => {
    const week = buildWeekPlan({
      userId: "u",
      weekStartDate: parseIsoDate("2027-03-15"),
      runsPerWeek: 4,
      indoorRuns: 0,
      nonImpactSessions: 0,
      nonImpactMachines: [],
      cycleWeekNumber: 1,
      phase: "specifique",
      qualityLevel: 3,
      longRunMinutes: 60,
      calibration: { zones, paceReferenceSecPerKm: 306, easyPaceSecPerKm: 375, marathonPaceSecPerKm: 420 },
      subjectiveEntries: [],
      availableDays: [0, 1, 2, 3, 4, 5, 6],
      racePlan: {
        phase: "specific",
        targetKm: 50,
        longRunMin: 100,
        keySession: "strides",
        isDeload: false,
        longRunMpBlock: { reps: 2, kmEach: 7 },
        qualityFromDay: 0,
        qualityLevel: 3,
      },
    });
    const long = week.sessions.find((x) => x.kind === "long")!;
    const mpMin = long.steps.filter((x) => x.zoneLabel === "Allure marathon").reduce((sum, x) => sum + (x.durationMinutes ?? 0), 0);
    assert.ok(mpMin + 30 <= 100, `${mpMin} min of MP in a 100 min run`);
    assert.match(long.whyNote, /Bloc réduit/);
  });
});

describe("config", () => {
  it("keeps the race week at or under half the peak", () => {
    for (const share of Object.values(RACE_PLAN_CONFIG.raceWeekVolumeShare)) assert.ok(share <= 0.5);
  });
});
