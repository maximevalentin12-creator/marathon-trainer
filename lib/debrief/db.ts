import type { Db } from "@/lib/supabase";
import { addDays, isoDate, parseIsoDate } from "@/lib/planner/dates";
import type { SubjectiveSignal } from "@/lib/planner/types";
import { debriefsToSignals, findOpenEpisode, qualityBlockNote, staleEpisodes } from "./logic";
import type {
  DebriefInput,
  DebriefSummary,
  DebriefView,
  InjuryEpisode,
  InjuryEpisodeHistory,
  PainOnset,
  PainReportInput,
  PendingDebrief,
} from "./types";

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

// ─── Reads for the UI ──────────────────────────────────────────────────────

const ACTIVITY_SKIP = /walk|strength|yoga|hik|pilates/i;

type EpisodeRef = { zone: InjuryEpisode["zone"]; side: InjuryEpisode["side"] };

/** Debrief views keyed by planned-session id, for the sessions that have one (matched by session or by activity). */
export async function loadDebriefViews(
  db: Db,
  userId: string,
  sessions: { id?: string; garmin_activity_id?: number | null }[]
): Promise<Map<string, DebriefView>> {
  const out = new Map<string, DebriefView>();
  const sessionIds = sessions.map((s) => s.id).filter((v): v is string => !!v);
  const activityIds = sessions.map((s) => s.garmin_activity_id).filter((v): v is number => v != null);
  if (sessionIds.length === 0) return out;

  const filter = [`planned_session_id.in.(${sessionIds.join(",")})`];
  if (activityIds.length > 0) filter.push(`garmin_activity_id.in.(${activityIds.join(",")})`);
  const { data, error } = await db
    .from("debriefs")
    .select(
      "id, planned_session_id, garmin_activity_id, effort, legs, energy, enjoyment, has_pain, injury_reports(intensity, episode:injury_episodes(zone, side))"
    )
    .eq("user_id", userId)
    .or(filter.join(","));
  if (error) throw new Error(error.message);

  type Row = {
    id: string;
    planned_session_id: string | null;
    garmin_activity_id: number | null;
    effort: number;
    legs: number;
    energy: number;
    enjoyment: number;
    has_pain: boolean;
    injury_reports: { intensity: number; episode: EpisodeRef | EpisodeRef[] | null }[];
  };
  for (const r of (data ?? []) as unknown as Row[]) {
    const view: DebriefView = {
      id: r.id,
      effort: r.effort,
      legs: r.legs,
      energy: r.energy,
      enjoyment: r.enjoyment,
      hasPain: r.has_pain,
      pain: r.injury_reports.flatMap((p) => {
        const ep = Array.isArray(p.episode) ? p.episode[0] : p.episode;
        return ep ? [{ zone: ep.zone, side: ep.side, intensity: p.intensity }] : [];
      }),
    };
    for (const s of sessions) {
      if (!s.id) continue;
      if (r.planned_session_id === s.id || (r.garmin_activity_id != null && r.garmin_activity_id === s.garmin_activity_id)) {
        out.set(s.id, view);
      }
    }
  }
  return out;
}

/** Synced activities of the last 21 days with no debrief yet, most recent first. */
export async function loadPendingDebriefs(db: Db, userId: string, today: string): Promise<PendingDebrief[]> {
  const from = isoDate(addDays(parseIsoDate(today), -21));
  const { data: acts, error } = await db
    .from("garmin_activities")
    .select("garmin_activity_id, activity_type, start_time, duration_seconds, distance_meters")
    .eq("user_id", userId)
    .gte("start_time", from)
    .order("start_time", { ascending: false });
  if (error) throw new Error(error.message);
  const candidates = (acts ?? []).filter(
    (a) => (a.duration_seconds ?? 0) >= 600 && !ACTIVITY_SKIP.test(a.activity_type ?? "")
  );
  if (candidates.length === 0) return [];

  const ids = candidates.map((a) => a.garmin_activity_id as number);
  const [{ data: done, error: doneError }, { data: planned }] = await Promise.all([
    db.from("debriefs").select("garmin_activity_id").eq("user_id", userId).in("garmin_activity_id", ids),
    db.from("planned_sessions").select("id, garmin_activity_id, session_label").eq("user_id", userId).in("garmin_activity_id", ids),
  ]);
  if (doneError) throw new Error(doneError.message);
  const doneIds = new Set((done ?? []).map((d) => d.garmin_activity_id as number));
  const plannedBy = new Map((planned ?? []).map((p) => [p.garmin_activity_id as number, p]));

  return candidates
    .filter((a) => !doneIds.has(a.garmin_activity_id))
    .map((a) => {
      const p = plannedBy.get(a.garmin_activity_id);
      return {
        garminActivityId: a.garmin_activity_id as number,
        plannedSessionId: (p?.id as string | undefined) ?? null,
        date: (a.start_time as string).slice(0, 10),
        label: (p?.session_label as string | null) ?? "Sortie",
        durationMinutes: a.duration_seconds != null ? Math.round(a.duration_seconds / 60) : null,
        distanceKm: a.distance_meters != null ? Math.round(a.distance_meters / 100) / 10 : null,
      };
    });
}

/** Every episode (open first, then most recent), each with its dated reports. */
export async function loadEpisodeHistory(db: Db, userId: string): Promise<InjuryEpisodeHistory[]> {
  const { data, error } = await db
    .from("injury_episodes")
    .select(`${EPISODE_COLUMNS}, notes, injury_reports(intensity, onset, affects_gait, debrief:debriefs(date))`)
    .eq("user_id", userId)
    .order("started_on", { ascending: false });
  if (error) throw new Error(error.message);
  type Row = EpisodeRow & {
    notes: string | null;
    injury_reports: {
      intensity: number;
      onset: PainOnset;
      affects_gait: boolean;
      debrief: { date: string } | { date: string }[] | null;
    }[];
  };
  const eps = ((data ?? []) as unknown as Row[]).map((r) => ({
    ...episodeFromRow(r),
    notes: r.notes,
    reports: r.injury_reports
      .map((p) => ({
        date: (Array.isArray(p.debrief) ? p.debrief[0]?.date : p.debrief?.date) ?? r.started_on,
        intensity: p.intensity,
        onset: p.onset,
        affectsGait: p.affects_gait,
      }))
      .sort((a, b) => b.date.localeCompare(a.date)),
  }));
  return eps.sort((a, b) => Number(a.resolvedOn !== null) - Number(b.resolvedOn !== null));
}

export async function markEpisodeResolved(db: Db, userId: string, episodeId: string, on: string): Promise<boolean> {
  const { data, error } = await db
    .from("injury_episodes")
    .update({ resolved_on: on })
    .eq("id", episodeId)
    .eq("user_id", userId)
    .is("resolved_on", null)
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}
