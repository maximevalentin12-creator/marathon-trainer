import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROFESSIONAL_NOTE,
  findOpenEpisode,
  legacyPainScore,
  parseDebriefInput,
  qualityBlockNote,
  staleEpisodes,
} from "./logic";
import type { DebriefSummary, InjuryEpisode } from "./types";

const debrief = (date: string, maxIntensity: number, affectsGait = false): DebriefSummary => ({
  date,
  energy: 3,
  hasPain: maxIntensity > 0,
  maxIntensity,
  affectsGait,
});

const episode = (over: Partial<InjuryEpisode> = {}): InjuryEpisode => ({
  id: "e1",
  zone: "calf",
  side: "left",
  startedOn: "2026-10-01",
  resolvedOn: null,
  peakIntensity: 4,
  affectsGait: false,
  ...over,
});

test("legacy pain score maps 0-10 onto 0-5", () => {
  assert.equal(legacyPainScore(debrief("2026-10-01", 0)), 0);
  assert.equal(legacyPainScore(debrief("2026-10-01", 5)), 3);
  assert.equal(legacyPainScore(debrief("2026-10-01", 8)), 4);
  assert.equal(legacyPainScore({ ...debrief("2026-10-01", 0), hasPain: true }), 1);
});

test("finds only an open episode in the same zone and side", () => {
  const eps = [episode(), episode({ id: "e2", zone: "knee" }), episode({ id: "e3", resolvedOn: "2026-10-05", side: "right" })];
  assert.equal(findOpenEpisode(eps, "calf", "left")?.id, "e1");
  assert.equal(findOpenEpisode(eps, "calf", "right"), null);
  assert.equal(findOpenEpisode(eps, "knee", "left")?.id, "e2");
});

test("episode auto-resolves after 14 days without a report, on its last report date", () => {
  const reports = new Map([["e1", "2026-10-05"]]);
  assert.deepEqual(staleEpisodes([episode()], reports, "2026-10-19"), []);
  assert.deepEqual(staleEpisodes([episode()], reports, "2026-10-20"), [{ id: "e1", resolvedOn: "2026-10-05" }]);
  assert.deepEqual(staleEpisodes([episode()], new Map(), "2026-10-20"), [{ id: "e1", resolvedOn: "2026-10-01" }]);
  assert.deepEqual(staleEpisodes([episode({ resolvedOn: "2026-10-02" })], reports, "2026-12-01"), []);
});

test("pain >= 4 on two consecutive debriefs blocks quality", () => {
  assert.equal(qualityBlockNote([debrief("2026-10-10", 4), debrief("2026-10-12", 6)], []), PROFESSIONAL_NOTE);
  assert.equal(qualityBlockNote([debrief("2026-10-10", 6), debrief("2026-10-12", 3)], []), null);
  assert.equal(qualityBlockNote([debrief("2026-10-10", 6)], []), null);
  assert.equal(qualityBlockNote([debrief("2026-10-08", 6), debrief("2026-10-10", 2), debrief("2026-10-12", 5)], []), null);
});

test("gait impact blocks quality, via the latest debrief or an open episode", () => {
  assert.equal(qualityBlockNote([debrief("2026-10-12", 2, true)], []), PROFESSIONAL_NOTE);
  assert.equal(qualityBlockNote([], [episode({ affectsGait: true })]), PROFESSIONAL_NOTE);
  assert.equal(qualityBlockNote([], [episode({ affectsGait: true, resolvedOn: "2026-10-05" })]), null);
});

test("parseDebriefInput validates ranges and pain reports", () => {
  const ok = { date: "2026-10-26", effort: 6, legs: 3, energy: 4, enjoyment: 5 };
  const [input] = parseDebriefInput({ ...ok, pain: [{ zone: "calf", side: "left", intensity: 4, onset: "during", affectsGait: true }] });
  assert.equal(input?.pain?.[0].affectsGait, true);
  assert.equal(parseDebriefInput({ ...ok, effort: 11 })[0], null);
  assert.equal(parseDebriefInput({ ...ok, legs: 0 })[0], null);
  assert.equal(parseDebriefInput({ ...ok, pain: [{ zone: "elbow", side: "left", intensity: 4, onset: "during" }] })[0], null);
  assert.deepEqual(parseDebriefInput(ok)[0]?.pain, []);
});
