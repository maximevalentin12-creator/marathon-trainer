// Browser-side Supabase client (anon key + the session cookies): used by the sign-in page and sign-out button only.
// All user data goes through the API routes, never straight from the browser.

import { createBrowserClient } from "@supabase/ssr";

export function createSupabaseBrowserClient() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}
