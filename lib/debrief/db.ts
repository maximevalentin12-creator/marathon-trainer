import type { Db } from "@/lib/supabase";
import { addDays, isoDate, parseIsoDate } from "@/lib/planner/dates";
import type { SubjectiveSignal } from "@/lib/planner/types";
import { debriefsToSignals, findOpenEpisode, qualityBlockNote, staleEpisodes } from "./logic";
import type { DebriefInput, DebriefSummary, InjuryEpisode, PainReportInput } from "./types";

interface EpisodeRow {
  id: string;
  zone: InjuryEpisode["zone"];
  side: InjuryEpisode["side"];
  started_on: string;
  resolved_on: string | null;
  peak_intensity: number;
  affects_gait: boolean;
}

function episodeFromRow(r: EpisodeRow): InjuryEpisode {
  return {
    id: r.id,
    zone: r.zone,
    side: r.side,
    startedOn: r.started_on,
    resolvedOn: r.resolved_on,
    peakIntensity: r.peak_intensity,
    affectsGait: r.affects_gait,
  };
}

const EPISODE_COLUMNS = "id, zone, side, started_on, resolved_on, peak_intensity, affects_gait";

export async function loadOpenEpisodes(db: Db, userId: string): Promise<InjuryEpisode[]> {
  const { data, error } = await db
    .from("injury_episodes")
    .select(EPISODE_COLUMNS)
    .eq("user_id", userId)
    .is("resolved_on", null);
  if (error) throw new Error(error.message);
  return ((data ?? []) as EpisodeRow[]).map(episodeFromRow);
}

/** Closes open episodes with no report for 14 days. Returns how many were resolved. */
export async function resolveStaleEpisodes(db: Db, userId: string, today: string): Promise<number> {
  const open = await loadOpenEpisodes(db, userId);
  if (open.length === 0) return 0;
  const { data, error } = await db
    .from("injury_reports")
    .select("episode_id, debrief:debriefs(date)")
    .eq("user_id", userId)
    .in("episode_id", open.map((e) => e.id));
  if (error) throw new Error(error.message);
  const lastReportOn = new Map<string, string>();
  for (const r of (data ?? []) as unknown as {
    episode_id: string;
    debrief: { date: string } | { date: string }[] | null;
  }[]) {
    const date = Array.isArray(r.debrief) ? r.debrief[0]?.date : r.debrief?.date;
    if (!date) continue;
    const prev = lastReportOn.get(r.episode_id);
    if (!prev || date > prev) lastReportOn.set(r.episode_id, date);
  }
  const stale = staleEpisodes(open, lastReportOn, today);
  for (const s of stale) {
    const { error: updateError } = await db
      .from("injury_episodes")
      .update({ resolved_on: s.resolvedOn })
      .eq("id", s.id)
      .eq("user_id", userId);
    if (updateError) throw new Error(updateError.message);
  }
  return stale.length;
}

/**
 * Links a pain report to the open episode in the same zone + side — raising its peak and gait flag —
 * or opens a new episode. Returns the episode id.
 */
export async function reportPain(
  db: Db,
  userId: string,
  debriefId: string,
  debriefDate: string,
  report: PainReportInput
): Promise<string> {
  const open = await loadOpenEpisodes(db, userId);
  const existing = findOpenEpisode(open, report.zone, report.side);

  let episodeId: string;
  if (existing) {
    episodeId = existing.id;
    const { error } = await db
      .from("injury_episodes")
      .update({
        peak_intensity: Math.max(existing.peakIntensity, report.intensity),
        affects_gait: existing.affectsGait || report.affectsGait,
      })
      .eq("id", episodeId)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
  } else {
    const { data, error } = await db
      .from("injury_episodes")
      .insert({
        user_id: userId,
        zone: report.zone,
        side: report.side,
        started_on: debriefDate,
        peak_intensity: report.intensity,
        affects_gait: report.affectsGait,
        notes: report.notes?.trim() || null,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    episodeId = data.id;
  }

  const { error } = await db.from("injury_reports").insert({
    user_id: userId,
    debrief_id: debriefId,
    episode_id: episodeId,
    intensity: report.intensity,
    onset: report.onset,
    affects_gait: report.affectsGait,
  });
  if (error) throw new Error(error.message);
  return episodeId;
}

/** Creates a debrief and its pain reports. One debrief per activity: a second one for the same activity fails. */
export async function createDebrief(db: Db, userId: string, input: DebriefInput): Promise<{ id: string }> {
  const pain = input.pain ?? [];
  const { data, error } = await db
    .from("debriefs")
    .insert({
      user_id: userId,
      garmin_activity_id: input.garminActivityId ?? null,
      planned_session_id: input.plannedSessionId ?? null,
      date: input.date,
      effort: input.effort,
      legs: input.legs,
      energy: input.energy,
      enjoyment: input.enjoyment,
      has_pain: pain.length > 0,
      notes: input.notes?.trim() || null,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  for (const report of pain) await reportPain(db, userId, data.id, input.date, report);
  await resolveStaleEpisodes(db, userId, input.date);
  return { id: data.id };
}

/** Debriefs dated in [from, to], with their pain reports folded in. */
export async function loadDebriefSummaries(db: Db, userId: string, from: string, to: string): Promise<DebriefSummary[]> {
  const { data, error } = await db
    .from("debriefs")
    .select("date, energy, has_pain, injury_reports(intensity, affects_gait)")
    .eq("user_id", userId)
    .gte("date", from)
    .lte("date", to);
  if (error) throw new Error(error.message);

  return (
    (data ?? []) as unknown as {
      date: string;
      energy: number;
      has_pain: boolean;
      injury_reports: { intensity: number; affects_gait: boolean }[];
    }[]
  ).map((r) => ({
    date: r.date,
    energy: r.energy,
    hasPain: r.has_pain,
    maxIntensity: Math.max(0, ...r.injury_reports.map((p) => p.intensity)),
    affectsGait: r.injury_reports.some((p) => p.affects_gait),
  }));
}

/** Debriefs in [from, to] as downgrade-rule signals — the replacement for the old subjective_entries lookup. */
export async function loadDebriefSignals(db: Db, userId: string, from: string, to: string): Promise<SubjectiveSignal[]> {
  return debriefsToSignals(await loadDebriefSummaries(db, userId, from, to));
}

/** Signals in [from, to] plus the quality block (if any) judged on the 14 days before `to`. */
export async function loadDebriefPlannerInput(
  db: Db,
  userId: string,
  from: string,
  to: string
): Promise<{ signals: SubjectiveSignal[]; qualityBlock: string | null }> {
  const blockFrom = isoDate(addDays(parseIsoDate(to), -14));
  const all = await loadDebriefSummaries(db, userId, from < blockFrom ? from : blockFrom, to);
  const open = await loadOpenEpisodes(db, userId);
  return {
    signals: debriefsToSignals(all.filter((d) => d.date >= from)),
    qualityBlock: qualityBlockNote(
      all.filter((d) => d.date >= blockFrom),
      open
    ),
  };
}
