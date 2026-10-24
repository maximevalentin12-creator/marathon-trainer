import crypto from "crypto";
import type { calendar_v3 } from "googleapis";
import { createServiceClient } from "@/lib/supabase";
import { getAuthorizedClient, getCalendarClient } from "@/lib/google/client";

const DEFAULT_CALENDAR_ID = "primary";

interface PlannedSessionRow {
  id: string;
  user_id: string;
  planned_date: string;
  session_type: string;
  session_label: string | null;
  target_distance_km: number | null;
  target_duration_minutes: number | null;
  target_pace_sec_per_km: number | null;
  why_note: string | null;
  google_calendar_event_id: string | null;
  google_calendar_payload_hash: string | null;
}

/** Fields that determine whether a row needs to be (re)synced. */
function syncableFields(row: {
  planned_date: string;
  session_type: string;
  session_label: string | null;
  target_distance_km: number | null;
  target_duration_minutes: number | null;
  target_pace_sec_per_km: number | null;
  why_note: string | null;
}) {
  return {
    planned_date: row.planned_date,
    session_type: row.session_type,
    session_label: row.session_label ?? "",
    target_distance_km: row.target_distance_km,
    target_duration_minutes: row.target_duration_minutes,
    target_pace_sec_per_km: row.target_pace_sec_per_km,
    why_note: row.why_note ?? "",
  };
}

function hashFields(fields: Record<string, unknown>): string {
  return crypto.createHash("sha1").update(JSON.stringify(fields)).digest("hex");
}

/** planned_date is a bare DATE — represent sessions as all-day Google events. */
function toEventBody(row: PlannedSessionRow): calendar_v3.Schema$Event {
  const nextDay = new Date(row.planned_date + "T00:00:00Z");
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);

  const duration = row.target_duration_minutes ? `${row.target_duration_minutes} min` : "";
  const label = row.session_label ?? `${row.session_type[0].toUpperCase()}${row.session_type.slice(1)}`;
  const summary = `${label}${duration ? ` — ${duration}` : ""}`;

  return {
    summary,
    description: [row.why_note, duration ? `Target duration: ${duration}` : null]
      .filter(Boolean)
      .join("\n\n"),
    start: { date: row.planned_date },
    end: { date: nextDay.toISOString().slice(0, 10) },
    extendedProperties: {
      private: { plannedSessionId: row.id, source: "marathon-app" },
    },
  };
}

/** Maps a (possibly user-edited) Google event back onto the syncable fields we own. */
function fromEvent(event: calendar_v3.Schema$Event, current: PlannedSessionRow) {
  const plannedDate = event.start?.date ?? event.start?.dateTime?.slice(0, 10) ?? current.planned_date;
  // Google's description may include our own "Target duration" line — strip it back out
  // so we don't keep re-appending it every round trip.
  const whyNote = (event.description ?? "").split("\n\nTarget duration:")[0].trim();

  return {
    planned_date: plannedDate,
    session_type: current.session_type,
    session_label: current.session_label,
    target_distance_km: current.target_distance_km,
    target_duration_minutes: current.target_duration_minutes,
    target_pace_sec_per_km: current.target_pace_sec_per_km,
    why_note: whyNote,
  };
}

export interface PushResult {
  pushed: number;
  skipped: number;
  failed: number;
}

/** Pushes every planned_sessions row for `userId` whose data has changed since the last sync. */
export async function pushUserSessions(userId: string, calendarId = DEFAULT_CALENDAR_ID): Promise<PushResult> {
  const supabase = createServiceClient();
  const auth = await getAuthorizedClient(userId);
  const calendar = getCalendarClient(auth);

  const { data: rows, error } = await supabase
    .from("planned_sessions")
    .select(
      "id, user_id, planned_date, session_type, session_label, target_distance_km, target_duration_minutes, target_pace_sec_per_km, why_note, google_calendar_event_id, google_calendar_payload_hash"
    )
    .eq("user_id", userId);

  if (error) throw new Error(error.message);

  const result: PushResult = { pushed: 0, skipped: 0, failed: 0 };

  for (const row of (rows ?? []) as PlannedSessionRow[]) {
    const hash = hashFields(syncableFields(row));
    if (row.google_calendar_event_id && hash === row.google_calendar_payload_hash) {
      result.skipped++;
      continue;
    }

    try {
      const body = toEventBody(row);
      let eventId = row.google_calendar_event_id;

      if (eventId) {
        try {
          await calendar.events.update({ calendarId, eventId, requestBody: body });
        } catch (err: unknown) {
          const status = (err as { code?: number; response?: { status?: number } })?.response?.status;
          if (status === 404 || status === 410) {
            // Event was deleted on the Google side out from under us — recreate it.
            eventId = null;
          } else {
            throw err;
          }
        }
      }

      if (!eventId) {
        const created = await calendar.events.insert({ calendarId, requestBody: body });
        eventId = created.data.id ?? null;
      }

      const { error: updateError } = await supabase
        .from("planned_sessions")
        .update({
          google_calendar_event_id: eventId,
          google_calendar_payload_hash: hash,
          google_calendar_synced_at: new Date().toISOString(),
        })
        .eq("id", row.id);

      if (updateError) throw new Error(updateError.message);
      result.pushed++;
    } catch (err) {
      console.error(`Failed to push planned_session ${row.id} to Google Calendar:`, err);
      result.failed++;
    }
  }

  return result;
}

export interface PullResult {
  updated: number;
  deleted: number;
  ignored: number;
}

async function processEvent(
  event: calendar_v3.Schema$Event,
  userId: string,
  supabase: ReturnType<typeof createServiceClient>,
  result: PullResult
) {
  if (!event.id) return;

  const { data: row } = await supabase
    .from("planned_sessions")
    .select(
      "id, user_id, planned_date, session_type, session_label, target_distance_km, target_duration_minutes, target_pace_sec_per_km, why_note, google_calendar_event_id, google_calendar_payload_hash"
    )
    .eq("user_id", userId)
    .eq("google_calendar_event_id", event.id)
    .maybeSingle();

  if (!row) {
    result.ignored++;
    return;
  }

  if (event.status === "cancelled") {
    const { error } = await supabase.from("planned_sessions").delete().eq("id", row.id);
    if (error) throw new Error(error.message);
    result.deleted++;
    return;
  }

  const mapped = fromEvent(event, row as PlannedSessionRow);
  const newHash = hashFields(mapped);
  if (newHash === (row as PlannedSessionRow).google_calendar_payload_hash) {
    result.ignored++;
    return; // no real change — avoids re-writing on our own push's echo notification
  }

  const { error } = await supabase
    .from("planned_sessions")
    .update({
      planned_date: mapped.planned_date,
      why_note: mapped.why_note,
      google_calendar_payload_hash: newHash,
      google_calendar_synced_at: new Date().toISOString(),
    })
    .eq("id", row.id);

  if (error) throw new Error(error.message);
  result.updated++;
}

/**
 * Pulls changes from Google Calendar into planned_sessions.
 * Uses an incremental sync token when we have one; otherwise performs a full
 * listing and stores the resulting token for next time.
 */
export async function runIncrementalSync(userId: string, calendarId = DEFAULT_CALENDAR_ID): Promise<PullResult> {
  const supabase = createServiceClient();
  const auth = await getAuthorizedClient(userId);
  const calendar = getCalendarClient(auth);

  const { data: syncState } = await supabase
    .from("google_calendar_sync")
    .select("sync_token")
    .eq("user_id", userId)
    .maybeSingle();

  const result: PullResult = { updated: 0, deleted: 0, ignored: 0 };
  let pageToken: string | undefined;
  let nextSyncToken: string | null | undefined;
  const syncToken = syncState?.sync_token ?? undefined;

  try {
    do {
      const res = await calendar.events.list({
        calendarId,
        syncToken,
        pageToken,
        singleEvents: true,
        showDeleted: true,
        ...(syncToken ? {} : { maxResults: 2500 }),
      });

      for (const event of res.data.items ?? []) {
        await processEvent(event, userId, supabase, result);
      }

      pageToken = res.data.nextPageToken ?? undefined;
      if (res.data.nextSyncToken) nextSyncToken = res.data.nextSyncToken;
    } while (pageToken);
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 410 && syncToken) {
      // Sync token expired/invalid — drop it and do a full resync.
      await supabase.from("google_calendar_sync").upsert({ user_id: userId, calendar_id: calendarId, sync_token: null });
      return runIncrementalSync(userId, calendarId);
    }
    throw err;
  }

  if (nextSyncToken) {
    const { error } = await supabase.from("google_calendar_sync").upsert({
      user_id: userId,
      calendar_id: calendarId,
      sync_token: nextSyncToken,
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
  }

  return result;
}

export interface WatchInfo {
  channelId: string;
  resourceId: string;
  expiration: string | null;
}

/**
 * Registers (or renews) a Google Calendar push-notification channel so that
 * edits made in Google Calendar are pushed to /api/google/webhook.
 * Requires APP_BASE_URL to be a public HTTPS address — Google will reject
 * plain-http or non-public webhook URLs (e.g. localhost).
 */
export async function watchUserCalendar(userId: string, calendarId = DEFAULT_CALENDAR_ID): Promise<WatchInfo> {
  // Ensure we have a sync token before watching, so the first webhook-driven
  // incremental sync has a baseline to diff against.
  await runIncrementalSync(userId, calendarId);

  const supabase = createServiceClient();
  const auth = await getAuthorizedClient(userId);
  const calendar = getCalendarClient(auth);

  const appBaseUrl = process.env.APP_BASE_URL;
  if (!appBaseUrl) throw new Error("Missing required env var: APP_BASE_URL");

  const { data: existing } = await supabase
    .from("google_calendar_sync")
    .select("channel_id, resource_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing?.channel_id && existing?.resource_id) {
    try {
      await calendar.channels.stop({
        requestBody: { id: existing.channel_id, resourceId: existing.resource_id },
      });
    } catch (err) {
      console.warn(`Could not stop previous Google Calendar channel for user ${userId}:`, err);
    }
  }

  const channelId = crypto.randomUUID();
  const channelToken = crypto.randomBytes(24).toString("hex");

  const res = await calendar.events.watch({
    calendarId,
    requestBody: {
      id: channelId,
      type: "web_hook",
      address: `${appBaseUrl.replace(/\/$/, "")}/api/google/webhook`,
      token: channelToken,
    },
  });

  const expiration = res.data.expiration ? new Date(Number(res.data.expiration)).toISOString() : null;

  const { error } = await supabase.from("google_calendar_sync").upsert({
    user_id: userId,
    calendar_id: calendarId,
    channel_id: channelId,
    resource_id: res.data.resourceId ?? null,
    channel_token: channelToken,
    channel_expiration: expiration,
    updated_at: new Date().toISOString(),
  });

  if (error) throw new Error(error.message);

  return { channelId, resourceId: res.data.resourceId ?? "", expiration };
}
