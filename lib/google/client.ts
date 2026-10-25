import { google } from "googleapis";
import type { Db } from "@/lib/supabase";

/** Cookie holding the one-time OAuth `state` between /api/google/auth and /api/google/callback. */
export const GOOGLE_STATE_COOKIE = "google_oauth_state";

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

/** Fresh, unauthenticated OAuth2 client — used to start/complete the auth flow. */
export function createOAuthClient() {
  return new google.auth.OAuth2(
    requiredEnv("GOOGLE_CLIENT_ID"),
    requiredEnv("GOOGLE_CLIENT_SECRET"),
    requiredEnv("GOOGLE_REDIRECT_URI")
  );
}

/** `state` is a one-time random value the caller keeps in a cookie and checks on return (CSRF protection). */
export function buildAuthUrl(state: string): string {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline", // required to receive a refresh_token
    prompt: "consent",      // force re-consent so we always get a refresh_token
    scope: [CALENDAR_SCOPE],
    state,
  });
}

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  scope: string | null;
  token_type: string | null;
  expiry_date: number | null;
}

/**
 * Loads stored tokens for a user, returns an OAuth2 client wired to persist
 * any refreshed access token (googleapis refreshes automatically on demand).
 */
export async function getAuthorizedClient(supabase: Db, userId: string) {
  const { data, error } = await supabase
    .from("google_oauth_tokens")
    .select("access_token, refresh_token, scope, token_type, expiry_date")
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    throw new Error(
      `No Google Calendar connection for user ${userId}. Visit /api/google/auth first.`
    );
  }

  const tokens = data as StoredTokens;
  const client = createOAuthClient();
  client.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    scope: tokens.scope ?? undefined,
    token_type: tokens.token_type ?? undefined,
    expiry_date: tokens.expiry_date ?? undefined,
  });

  client.on("tokens", (refreshed) => {
    void supabase
      .from("google_oauth_tokens")
      .update({
        access_token: refreshed.access_token ?? tokens.access_token,
        // Google only returns a new refresh_token occasionally (e.g. first
        // consent, or forced re-consent) — keep the old one otherwise.
        refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
        expiry_date: refreshed.expiry_date ?? tokens.expiry_date,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .then(undefined, (err) => {
        console.error(`Failed to persist refreshed Google token for user ${userId}:`, err);
      });
  });

  return client;
}

export function getCalendarClient(auth: InstanceType<typeof google.auth.OAuth2>) {
  return google.calendar({ version: "v3", auth });
}
