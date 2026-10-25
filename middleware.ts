import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Every page and API route needs a signed-in user, except:
 *  - /login (the sign-in page);
 *  - /api/google/webhook — Google's push notifications carry no Supabase session; the route authenticates
 *    them itself with the per-channel token stored in google_calendar_sync.
 * Static assets (manifest, service worker, icons) are excluded by the matcher below.
 * The middleware also refreshes the session cookies.
 */
const PUBLIC_PATHS = ["/login", "/api/google/webhook"];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(list: { name: string; value: string; options: CookieOptions }[]) {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;

  if (!user && !PUBLIC_PATHS.includes(path)) {
    if (path.startsWith("/api/")) return NextResponse.json({ error: "Non connecté." }, { status: 401 });
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = path === "/" ? "" : `?next=${encodeURIComponent(path + request.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }
  if (user && path === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.json|sw.js|icons/|shoes/|.*\.(?:png|jpg|jpeg|svg|gif|webp|ico)$).*)"],
};
