# Marathon App

A personal running journal with a rule-based weekly planner. It pulls your activities from Garmin Connect, plans your next week of training from fixed rules (no machine learning, no LLM), then checks each completed run against what was planned and tells you why it did or didn't match.

It was built for one person (me) who runs 2–3 times a week and cross-trains alongside. It is a hobby project, not a product — see [Known limitations](#known-limitations).

> The UI copy is in French.

## Screenshots

<!-- Replace the placeholders with real captures (put files in docs/screenshots/). -->

| Weekly plan | Session analysis | History |
|---|---|---|
| _screenshot: weekly plan_ | _screenshot: post-session analysis_ | _screenshot: history_ |

| Profile & HR zones | Shoe rotation | Monthly report |
|---|---|---|
| _screenshot: profile_ | _screenshot: shoes_ | _screenshot: monthly report_ |

## Features

- **Weekly planner** — generates a week of 1–4 sessions (easy, long, threshold, VO2max, rest) from your recent volume, HR zones and how you felt after earlier runs.
- **Progression safeguards** — long run length is stored and progressed gradually, a volume brake caps weekly increases, and the long run is placed the day after a hard session only when needed.
- **Indoor, outdoor and non-impact variants** — treadmill sessions (incline cycling), and bike / assault bike / elliptical sessions with shifted HR targets.
- **Garmin sync** — imports activities (and laps for quality sessions) and matches them to planned sessions.
- **Post-session analysis** — scores each completed session against the plan: work laps for intervals, heart rate first for continuous runs, plus flags such as HR drift or indoor/outdoor mismatch.
- **Personal HR zones and easy pace** — calibrated from your own profile and recent runs rather than generic tables.
- **Subjective log** — mood, niggles and tension after runs; these feed back into the next plan (downgrade or rest).
- **Shoe rotation** — mileage per pair with wear indicators.
- **Races and temporary race mode** — add a race and the planner switches to a preparation block, then reverts.
- **Google Calendar sync** — push planned sessions to a calendar, with incremental updates via push notifications.
- **CSV import** — load Garmin activity exports.
- **History, trends and a monthly PDF report.**
- **Installable PWA** (manifest + service worker).

## Stack

- **Frontend / API:** Next.js 14 (App Router), React 18, TypeScript, Tailwind CSS
- **Database:** Supabase (Postgres)
- **Garmin sync:** Python 3 with [`garminconnect`](https://github.com/cyberjunky/python-garminconnect)
- **Other:** `googleapis` (Calendar), `pdfkit` (reports)

## Architecture

```
app/                 Next.js pages and API routes (app/api/*)
components/          Dashboard cards and UI pieces
lib/planner/         The rule-based planner (pure TypeScript, no I/O)
lib/garmin/          CSV parsing and activity <-> planned-session matching
lib/google/          Calendar OAuth client and sync
lib/athlete/         Profile calibration (HR max, resting HR)
lib/reports/         Monthly summary and PDF generation
scripts/             sync_garmin.py (Garmin -> Supabase), dedupe script
supabase/schema.sql  Full database schema
```

**Garmin sync with persisted tokens.** `scripts/sync_garmin.py` is spawned by the `/api/garmin/sync` route. It logs in with your Garmin credentials once (`--login`), then stores the session tokens in the `garmin_tokens` table in Supabase and reuses them on every later run. Repeated credential logins are what trigger Garmin's rate limiting, so on a 429 or a Cloudflare challenge the script does not retry; it records a cooldown timestamp and refuses to contact Garmin until it passes.

**Planner rules.** `lib/planner/` is deterministic: given the athlete's zones, recent history, stored long-run length, subjective signals and an optional race, `buildWeekPlan()` returns the week. Zones are derived from max HR and resting HR (heart-rate-reserve percentages). Easy pace is read off recent runs at the top of the easy zone. Quality sessions are scored on their work laps. Subjective signals can downgrade a session to easy or to rest. Race mode (`race.ts`) overrides the normal week structure until the race has passed.

**Identity.** There is no authentication. Onboarding creates a `users` row and the browser keeps its id in `localStorage`; API routes receive it as a parameter and use the Supabase service-role key server-side.

## Setup

Requirements: Node.js 18+, Python 3.10+, a [Supabase](https://supabase.com) project, and a Garmin Connect account. A Google Cloud OAuth client is only needed for Calendar sync.

1. **Install dependencies**
   ```bash
   npm install
   python -m pip install -r scripts/requirements.txt
   ```
2. **Create the database** — run `supabase/schema.sql` in the Supabase SQL editor.
3. **Configure the environment**
   ```bash
   cp .env.local.example .env.local
   ```
   Fill in the Supabase URL and keys, your Garmin credentials and (optionally) the Google OAuth values. `.env.local` is gitignored — never commit it. The service-role key bypasses row-level security; keep it server-side only.
4. **Start the app**
   ```bash
   npm run dev
   ```
   Open http://localhost:3000 and complete `/onboarding`, which creates your user and runs a first Garmin sync.
5. **Bootstrap Garmin tokens (once)**, using the user id created at onboarding:
   ```bash
   python scripts/sync_garmin.py --login --user-id <your-user-uuid>
   ```
   The script also reads `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (the app sets these for it when it spawns the script). When running it by hand, put them in a `.env` file at the project root or export them.
6. **Google Calendar (optional)** — Google requires HTTPS for push webhooks, so locally set `APP_BASE_URL` to a tunnel URL (e.g. ngrok) and add the redirect URI to your OAuth client.

## Known limitations

- **Single user, no authentication.** Anyone who can reach the server and knows a user id can read that user's data. Do not expose it to the internet as is.
- **Runs locally.** The Garmin sync spawns a Python process from the API route, which won't work on a serverless host such as Vercel without changes.
- **Unofficial Garmin API.** `garminconnect` relies on Garmin's private endpoints, which can break or be rate-limited at any time.
- **Rules, not science.** The planner encodes one person's reading of the training literature for low-frequency running (2–3 sessions/week). It is not medical or coaching advice.
- **French UI only**, and tuned to one athlete's setup (HR-based zones, strength and grappling cross-training in mind).
- **Monthly report suggestions are a stub** (`lib/reports/claudeSuggestions.ts`).
- **No automated tests.**

## License

[MIT](LICENSE)
