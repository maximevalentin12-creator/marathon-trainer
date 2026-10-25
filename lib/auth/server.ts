// Server-side auth for route handlers and server components: a Supabase client that carries the signed-in
// user's session (anon key + session cookies), so Row Level Security (auth.uid() = user_id) applies to every
// query. The service-role key is NOT used here — see lib/supabase.ts for the few places that still need it.

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export function createSupabaseServerClient() {
  const cookieStore = cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(list: { name: string; value: string; options: CookieOptions }[]) {
        try {
          list.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a server component, which cannot set cookies: the middleware refreshes the session instead.
        }
      },
    },
  });
}

export type UserDb = ReturnType<typeof createSupabaseServerClient>;

export type AuthResult =
  | { ok: true; userId: string; email: string | null; db: UserDb }
  | { ok: false; response: NextResponse };

/**
 * The signed-in user of this request, or a ready 401 response. The user id comes from the verified session —
 * never from a query string or a body.
 *
 *   const auth = await requireUser();
 *   if (!auth.ok) return auth.response;
 *   const { userId, db } = auth;
 */
export async function requireUser(): Promise<AuthResult> {
  const db = createSupabaseServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: "Non connecté." }, { status: 401 }) };
  return { ok: true, userId: user.id, email: user.email ?? null, db };
}
