# Marathon App

A personal running journal with a rule-based training planner. It pulls your activities from Garmin Connect, builds a plan backward from your goal race (or a continuous week-by-week plan when there is none), then checks each completed run against what was planned and tells you why it did or didn't match. No machine learning, no LLM — fixed, readable rules.

It was built for one person (me) who runs 3–5 times a week and cross-trains alongside. It is a hobby project, not a product — see [Known limitations](#known-limitations).

> The UI copy is in French.

## Features

- **Race planner** — give it a goal race (marathon, half, 10K, 5K) and optional tune-up races; it lays out every week backward from race day: recovery after your last race, base, development, specific, taper, race week. Volume ramps at most +10 %/week with a lighter week every fourth week back from the race; long runs peak at set weeks before the race; marathon-pace work grows from short finishes to long blocks; every race brings its own easy days before and after. Paces come from your latest race result (Riegel). All the tunable numbers live in `lib/planner/config.ts`.
- **Plan screen** — one row per week with phase, km, long run, marathon-pace km, key session and race markers; tap a week for its sessions or targets.
- **Weekly planner** — generates the week's sessions (easy, long, threshold, VO2max, rest) for 3–5 runs a week, from the race plan or, with no goal race, from recent volume and your progression. Subjective signals (pain, energy) can downgrade a session; quality is never placed the day before or after the long run.
- **Indoor, outdoor and non-impact variants** — treadmill sessions, and bike / assault bike / elliptical sessions with shifted HR targets.
- **Garmin sync** — activities are imported automatically twice a day by a scheduled job, then matched to planned sessions.
- **Post-session analysis** — scores each completed session against the plan: work laps for intervals, heart rate for continuous runs, plus flags such as HR drift or indoor/outdoor mismatch.
- **Personal HR zones and easy pace** — calibrated from your own profile and recent runs.
- **Subjective log**, **shoe rotation**, **history**, **trends**, **monthly PDF report**, **CSV import**.
- **Google Calendar sync** (optional) — push planned sessions to a calendar, with updates coming back through push notifications.
- **Sign-in** — Supabase Auth with e-mail and password; single athlete, no sign-up page.
- **Installable PWA** with a bottom tab bar on phones.

## Stack

- **Frontend / API:** Next.js 14 (App Router), React 18, TypeScript, Tailwind CSS
- **Database and auth:** Supabase (Postgres, Auth, row-level security)
- **Garmin sync:** Python 3 with [`garminconnect`](https://github.com/cyberjunky/python-garminconnect), run by GitHub Actions
- **Hosting:** Vercel
- **Other:** `googleapis` (Calendar), `pdfkit` (reports)

## Architecture

```
app/                 Next.js pages and API routes (app/api/*)
components/          Screen pieces (race sheet, week plan, tab bar…)
lib/planner/         The planners (pure TypeScript, no I/O): racePlan.ts, rules.ts, config.ts, paces.ts…
lib/auth/            Supabase session clients (server + browser)
lib/garmin/          CSV parsing and activity <-> planned-session matching
lib/google/          Calendar OAuth client and sync
lib/athlete/         Profile calibration (HR max, resting HR)
lib/reports/         Monthly summary and PDF generation
middleware.ts        Auth gate for every page and API route
scripts/             sync_garmin.py (Garmin -> Supabase) and its tests
supabase/schema.sql  Database schema; supabase/migrations/ holds one-off migrations
.github/workflows/   The scheduled Garmin sync
```

**Authentication and data access.** Every page and API route requires a signed-in user, except `/login` and the Google Calendar webhook (which authenticates Google's call with a per-channel secret). The server reads the user id from the verified session — never from the URL or a request body — and queries Supabase with the anon key plus the user's session, so the row-level-security policies (`auth.uid() = user_id`) are what protect the data. The service-role key is used in only two places: the Google webhook, and the Garmin sync job.

**Garmin sync.** `scripts/sync_garmin.py` logs in with your Garmin credentials once, on your machine (`--login`), and stores the session tokens in the `garmin_tokens` table. The scheduled GitHub Actions job (`.github/workflows/sync-garmin.yml`, 07:00 and 20:00 Paris time) only *resumes* that stored session: it never sends a password, and on a 429 or Cloudflare challenge it does not retry — it records a cooldown and refuses to contact Garmin until it passes. Because the repository is public, so are the job logs; the script logs only counts, dates and error class names (`scripts/test_sync_garmin.py` guards that). In production (Vercel) the "Actualiser mes séances" button does not run Python; it matches the freshly imported activities to your planned sessions. Locally the button still runs the script.

**Planner rules.** `buildRacePlan()` (`lib/planner/racePlan.ts`) turns a goal race, its tune-ups and your recent history into one entry per week; `buildWeekPlan()` (`rules.ts`) turns a week's entry, your weekly setup and your recent feelings into dated sessions. Without a goal race the older continuous mode (progression blocks, stored long run, volume brake) runs unchanged.

## Setup (local)

Requirements: Node.js 18+, Python 3.10+, a [Supabase](https://supabase.com) project, a Garmin Connect account. A Google Cloud OAuth client is only needed for Calendar sync.

1. **Install**
   ```bash
   npm install
   python -m pip install -r scripts/requirements.txt
   ```
2. **Create the database** — run `supabase/schema.sql` in the Supabase SQL editor.
3. **Create your login** — in Supabase, Authentication → turn **off** "Allow new users to sign up", then run `supabase/migrations/2026-10-auth-cutover.sql` (edit the user id and password at the top first). It creates the login with the id your data already uses and sets one row-level-security policy per table. For a brand-new database, insert your row in `public.users` first.
4. **Configure the environment**
   ```bash
   cp .env.local.example .env.local
   ```
   Fill it in — the file explains every variable. `.env.local` is gitignored; never commit it.
5. **Start**
   ```bash
   npm run dev
   ```
   Open http://localhost:3000 and sign in.
6. **Garmin session (once)**
   ```bash
   python scripts/sync_garmin.py --login --user-id <your-user-uuid>
   ```
   Reads `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` from the environment or a `.env` file (the app passes them itself when it runs the script). Handles an MFA prompt.
7. **Seed your races (optional)** — add them from the Plan screen.

### Tests

```bash
npm test                                      # planner rules (node:test via tsx)
python -m unittest scripts/test_sync_garmin.py   # Garmin script: log hygiene, no credential login in scheduled runs
npx tsc --noEmit                              # types
npm run build                                 # production build
```

## Deploy

**Vercel (the app)**

1. Import the GitHub repository as a new project (framework: Next.js, no settings to change; there is no `vercel.json`).
2. Environment variables (Project → Settings → Environment Variables, Production):
   - Required, public: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
   - Optional, server-only — only for Google Calendar: `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `APP_BASE_URL`.
   - Optional, for push notifications: `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (public), `VAPID_PRIVATE_KEY` (server-only), `VAPID_SUBJECT` (optional `mailto:`, defaults to the signed-in email). Generate with `npx web-push generate-vapid-keys`.
   - Not needed on Vercel: `GARMIN_USERNAME`, `GARMIN_PASSWORD` (local use only).
3. Deploy, open the URL and sign in.

**GitHub (the scheduled Garmin sync)** — Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `SUPABASE_URL` | `https://<project>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | the project's `service_role` key |
| `GARMIN_SYNC_USER_ID` | your user uuid |

No Garmin password is stored on GitHub. Run the workflow once by hand (Actions → Sync Garmin → Run workflow) and check it is green. GitHub pauses scheduled workflows after 60 days without repository activity.

## Known limitations

- **Single athlete.** There is one login and no sign-up; the code is written around one person's data.
- **Unofficial Garmin API.** `garminconnect` relies on Garmin's private endpoints, which can break or be rate-limited at any time — and Garmin may throttle GitHub's shared runner addresses. The cooldown makes a block harmless but a blocked sync would need to run from your own machine instead.
- **Rules, not science.** The planner encodes one person's reading of the training literature. It is not medical or coaching advice.
- **French UI only**, tuned to one athlete's setup.
- **Monthly report suggestions are a stub** (`lib/reports/claudeSuggestions.ts`).
- **Test coverage is the planner and the sync script's logging**, not the screens or the API routes.

## License

[MIT](LICENSE)
