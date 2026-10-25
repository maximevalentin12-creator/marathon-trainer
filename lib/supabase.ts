import { createClient } from "@supabase/supabase-js";

/** A Supabase client — the user's (lib/auth/server.ts) or the service one below. */
export type Db = ReturnType<typeof createServiceClient>;

/**
 * Service-role client: BYPASSES Row Level Security. Never use it for a request made by a signed-in user —
 * those go through lib/auth/server.ts (anon key + the user's session), so RLS applies.
 * It remains in exactly two places:
 *  1. app/api/google/webhook — Google's push notifications carry no Supabase session; the route looks the
 *     user up from the channel id and verifies the per-channel token before touching anything;
 *  2. the Garmin sync script (scripts/sync_garmin.py), which app/api/garmin/sync spawns with the service key
 *     in its environment (the script writes activities in bulk), after checking the caller's session.
 * (scripts/print-race-plan.ts is a local read-only CLI and uses it too.)
 */
export function createServiceClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}
