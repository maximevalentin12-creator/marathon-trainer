// Subjective downgrade rules (spec §2). Pure decision logic — rules.ts applies
// the decision using its own session templates.

import type { SessionKind, SubjectiveSignal } from "./types";

export type DowngradeAction =
  | { type: "none" }
  | { type: "rest"; reason: string }
  | { type: "toEasy"; reason: string }
  | { type: "shortenLong"; factor: number; reason: string };

const HOUR_MS = 3600 * 1000;

/**
 * Finds the most recent subjective_entries signal dated less than 48h before
 * sessionDate (never one logged after it — a session-day check needs the
 * state as of that day, not hindsight from a later entry).
 */
export function findApplicableSignal(
  entries: SubjectiveSignal[],
  sessionDate: Date
): SubjectiveSignal | null {
  let best: SubjectiveSignal | null = null;
  for (const entry of entries) {
    const diffMs = sessionDate.getTime() - entry.entryDate.getTime();
    if (diffMs < 0 || diffMs > 48 * HOUR_MS) continue;
    if (!best || entry.entryDate.getTime() > best.entryDate.getTime()) best = entry;
  }
  return best;
}

export function decideDowngrade(kind: SessionKind, signal: SubjectiveSignal | null): DowngradeAction {
  // The race is a fixed event, not a prescription — it's never swapped for something else.
  if (kind === "rest" || kind === "race" || !signal) return { type: "none" };

  if (signal.painScore >= 4) {
    return {
      type: "rest",
      reason: "Douleur élevée signalée récemment — repos complet aujourd'hui, jamais la séance prévue.",
    };
  }

  if (signal.painScore >= 3) {
    if (kind === "easy") return { type: "none" };
    return {
      type: "toEasy",
      reason:
        "Douleur signalée récemment — séance remplacée par une sortie facile, jamais une séance qualité ou longue tant que ça tire.",
    };
  }

  if (signal.energyScore <= 2) {
    if (kind === "threshold" || kind === "vo2max") {
      return {
        type: "toEasy",
        reason: "Énergie basse signalée récemment — la séance qualité prévue devient une sortie facile.",
      };
    }
    if (kind === "long") {
      return {
        type: "shortenLong",
        factor: 0.75,
        reason: "Énergie basse signalée récemment — la sortie longue est raccourcie d'environ 25 % aujourd'hui.",
      };
    }
  }

  return { type: "none" };
}

/** Strides (spec §4 E) only ever get added to a Facile session, and only on a good-energy day. */
export function shouldAddStrides(signal: SubjectiveSignal | null): boolean {
  return !!signal && signal.painScore < 3 && signal.energyScore >= 4;
}
