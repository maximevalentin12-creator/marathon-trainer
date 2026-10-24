#!/usr/bin/env python3
"""
Garmin Connect → Supabase sync.

Standalone usage:
    python scripts/sync_garmin.py                       # normal sync run
    python scripts/sync_garmin.py --login --user-id <uuid>   # one-time bootstrap
    python scripts/sync_garmin.py --fetch-laps               # laps for quality-matched activities

Auth model (see supabase/schema.sql's garmin_tokens table):
    The garminconnect library is designed to authenticate with a username and
    password ONCE, then reuse persisted session tokens (mobile SSO / DI OAuth
    Bearer — see garminconnect.client.Client.dumps()) — OAuth1-equivalent
    tokens last ~1 year, OAuth2-equivalent ~20h with automatic refresh. Each
    credential login() cycles through 4-5 SSO strategies (see
    garminconnect/client.py's module docstring), so calling it on every sync
    run — instead of once — is what triggers Garmin's rate limiting.

    So: tokens are persisted in Supabase (not a local file — the app deploys
    to Vercel, whose filesystem is ephemeral, which would force a fresh
    credential login on every cold start). Every run loads the stored token
    payload and resumes the session; a full credential login only happens
    when no tokens exist or they're unusable (never on a rate limit — see
    is_rate_limited() below). Run once with --login to establish the first
    tokens; every run after that should show 0 credential logins in the log
    output and summary JSON — if it doesn't, token persistence has regressed.

    On a rate limit (HTTP 429 or a Cloudflare challenge) this script does NOT
    retry — it fails immediately and records a cooldown timestamp in
    garmin_tokens.cooldown_until, and every subsequent run refuses to contact
    Garmin at all until that passes. Retrying during a block is what extends
    it.

Required env vars (also read from .env in project root via python-dotenv):
    GARMIN_USERNAME       your Garmin Connect email
    GARMIN_PASSWORD       your Garmin Connect password
    SUPABASE_URL          https://<project>.supabase.co
    SUPABASE_SERVICE_KEY  service-role key (bypasses RLS)

Required (unless --allow-anonymous is passed):
    USER_ID               UUID — links each activity to a users row, and is
                           the key tokens/cooldown state are stored under.
                           Pass via env var, or --user-id on the command line.

Optional:
    DAYS_BACK                        how many days to look back (default: 1825 = 5 years)
    GARMIN_COOLDOWN_MINUTES           cooldown length after a rate limit (default: 60)
    LAPS_MAX_PER_RUN                  --fetch-laps: max activities fetched per run (default: 10)
    LAPS_DELAY_SECONDS                --fetch-laps: pause between two splits calls (default: 2)

--allow-anonymous runs without a user_id, which also means without token/
cooldown persistence — every such run does a full credential login. It exists
only for scratch/debug use, same as before; prefer a real --user-id.
"""

import argparse
import contextlib
import json
import logging
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone

# Load .env if present (dev convenience)
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

try:
    import garminconnect
except ImportError:
    garminconnect = None


# ─── Rate-limit detection ───────────────────────────────────────────────────

# The exact phrases garminconnect actually raises with (see its login(),
# connectapi(), and client.py's portal/widget/mobile 429 and Cloudflare-HTML-
# challenge handling) — not a blind "429" substring check. That both
# over-matches (unrelated errors can coincidentally contain "429") and
# under-matches: the library's own message for a login-time rate limit is
# "Too many login attempts. Please wait a few minutes before trying again.",
# which contains no digits at all.
RATE_LIMIT_PHRASES = (
    "too many login attempts",
    "too many requests",
    "rate limit",
    "cloudflare",
)


def is_rate_limited(exc: BaseException) -> bool:
    """True if `exc` — or anything in its __cause__/__context__ chain — is a
    Garmin rate limit or Cloudflare block.

    Chain-walking matters: garminconnect's Garmin.login() retries its
    post-login profile/settings fetch 3x on ANY exception and, on final
    failure, re-raises as GarminConnectAuthenticationError("Failed to
    retrieve social profile") — via `raise ... from e`, which preserves the
    original GarminConnectTooManyRequestsError as __cause__. Checking only
    the outer exception's type would misclassify that as a plain auth
    failure and (incorrectly) trigger a credential-login fallback.
    """
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if garminconnect is not None and isinstance(
            current, garminconnect.GarminConnectTooManyRequestsError
        ):
            return True
        if any(phrase in str(current).lower() for phrase in RATE_LIMIT_PHRASES):
            return True
        current = current.__cause__ or current.__context__
    return False


# ─── Capturing per-strategy warnings during a login attempt ────────────────
#
# garminconnect.client.Client.login() tries 5 SSO strategies in order; only
# GarminConnectAuthenticationError (a positive "wrong credentials" verdict)
# stops the chain early. Every other per-strategy failure — including a 429
# or Cloudflare challenge — is only ever logged (`_LOGGER.warning("%s
# returned 429: %s", name, e)`) and then discarded: the loop keeps the LAST
# failure in a local `last_err` that gets overwritten on every iteration.
#
# If EVERY strategy hits 429, the library raises GarminConnectTooManyRequestsError
# itself (already handled above). But a MIX — some strategies 429, then a
# different, non-429 failure on the last one — raises the generic
# `GarminConnectConnectionError(f"All login strategies exhausted: {last_err}")`,
# where `last_err` is only the final strategy's error: the earlier 429/Cloudflare
# evidence never reaches the exception at all, not even via __cause__. The only
# place that evidence still exists is the log records the loop emitted along the
# way — so that's what we capture and inspect.
RATE_LIMIT_WARNING_MARKERS = ("429", "cloudflare")


class _WarningCapture(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.WARNING)
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(record.getMessage())


@contextlib.contextmanager
def capture_garmin_warnings():
    """Captures WARNING+ log records from garminconnect's loggers (client.py's
    per-strategy login warnings included) for the duration of the `with` block,
    without suppressing their normal propagation to the console."""
    handler = _WarningCapture()
    logger = logging.getLogger("garminconnect")
    logger.addHandler(handler)
    try:
        yield handler
    finally:
        logger.removeHandler(handler)


def any_strategy_rate_limited(warning_messages: list[str]) -> bool:
    """True if any captured per-strategy warning reported a 429 or Cloudflare
    block — the trusted, structured source described above. Matching a bare
    "429" here is safe (unlike in is_rate_limited()'s exception-text scan):
    these are garminconnect's own hardcoded log format strings, not free-form
    third-party error text."""
    return any(
        marker in msg.lower() for msg in warning_messages for marker in RATE_LIMIT_WARNING_MARKERS
    )


def classify_login_failure(exc: BaseException, warning_messages: list[str]) -> tuple[str, str]:
    """Classifies a failed login attempt so a credential typo is never reported
    as a Garmin block, and a real block is always recognized even when the
    final raised exception doesn't itself say so.

    Returns (reason, message) where reason is one of:
      "rate_limited" — record a cooldown, don't blame credentials.
      "auth_failed"  — a positive wrong-credentials verdict; never cooldown.
      "other"        — genuinely unclear; don't claim either, don't cooldown.
    """
    if is_rate_limited(exc):
        return "rate_limited", f"Rate limited by Garmin: {exc}"

    if garminconnect is not None and isinstance(exc, garminconnect.GarminConnectAuthenticationError):
        return (
            "auth_failed",
            f"Authentication failed — check GARMIN_USERNAME/GARMIN_PASSWORD "
            f"(this is a credentials problem, not a Garmin rate limit): {exc}",
        )

    if any_strategy_rate_limited(warning_messages):
        return (
            "rate_limited",
            "Rate limited by Garmin: one or more login strategies were throttled "
            f"(429/Cloudflare) before the overall attempt failed with: {exc}",
        )

    return (
        "other",
        f"Login failed for a reason that's neither a clear Garmin rate limit nor a "
        f"clear credentials rejection — check GARMIN_USERNAME/GARMIN_PASSWORD, but this "
        f"could also be transient: {exc}",
    )


# ─── Supabase-backed auth session state ─────────────────────────────────────


def load_auth_state(db, user_id: str) -> dict:
    """Returns {"token_payload": dict | None, "cooldown_until": datetime | None}."""
    resp = (
        db.table("garmin_tokens")
        .select("token_payload, cooldown_until")
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )
    row = resp.data if resp else None
    if not row:
        return {"token_payload": None, "cooldown_until": None}
    cooldown_until = None
    if row.get("cooldown_until"):
        cooldown_until = datetime.fromisoformat(row["cooldown_until"].replace("Z", "+00:00"))
    return {"token_payload": row.get("token_payload"), "cooldown_until": cooldown_until}


def save_tokens(db, user_id: str, token_payload: dict) -> None:
    """Persist a successful login/refresh's tokens and clear any cooldown."""
    db.table("garmin_tokens").upsert(
        {"user_id": user_id, "token_payload": token_payload, "cooldown_until": None},
        on_conflict="user_id",
    ).execute()


def record_cooldown(db, user_id: str, until: datetime, existing_token_payload: dict | None) -> None:
    """Record a rate-limit cooldown. Explicitly carries forward the existing
    token payload (rather than a partial upsert) so a cooldown hit while
    resuming a still-good session doesn't wipe out those tokens."""
    db.table("garmin_tokens").upsert(
        {
            "user_id": user_id,
            "token_payload": existing_token_payload,
            "cooldown_until": until.isoformat(),
        },
        on_conflict="user_id",
    ).execute()


def cooldown_remaining_message(cooldown_until: datetime) -> str:
    now = datetime.now(timezone.utc)
    remaining_min = max(0, round((cooldown_until - now).total_seconds() / 60))
    return (
        f"Garmin sync is cooling down until {cooldown_until.isoformat()} "
        f"({remaining_min} more minute{'s' if remaining_min != 1 else ''}) after a rate limit "
        "was hit. Refusing to contact Garmin until then — retrying during a block is what "
        "extends it."
    )


# ─── Credential-login counter ───────────────────────────────────────────────


def install_login_counter(api) -> dict:
    """Wraps api.client.login (the actual username/password SSO entrypoint)
    so every credential login — whether from our own api.login(tokenstore=None)
    call, or from garminconnect's own internal tokenstore-resume-failed
    fallback — is counted, regardless of which code path triggered it. This
    is the single place credentials are ever sent to Garmin, so it's the only
    reliable way to detect a regression back to logging in every run."""
    original_login = api.client.login
    state = {"count": 0}

    def counting_login(*args, **kwargs):
        state["count"] += 1
        log.warning("Credential login #%d this run (username/password SSO flow).", state["count"])
        return original_login(*args, **kwargs)

    api.client.login = counting_login
    return state


# ─── Helpers ─────────────────────────────────────────────────────────────────


def require_env(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        log.error("Missing required env var: %s", name)
        sys.exit(1)
    return val


def pace_sec_per_km(distance_m: float, duration_s: float) -> float | None:
    if not distance_m or distance_m < 50:
        return None
    return round(duration_s / (distance_m / 1000), 1)


# Native Garmin activity ids are below this; CSV-synthetic ids
# (syntheticActivityId() in lib/garmin/parseCsv.ts, a 51-bit hash) are above it.
NATIVE_ID_MAX = 10**12


def start_time_key(value: str | None) -> datetime | None:
    """Naive-UTC datetime for a start_time, whether Garmin's naive
    "YYYY-MM-DD HH:MM:SS" (stored as UTC) or a timestamptz read back from the DB."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def load_synthetic_by_start(db, user_id: str) -> dict:
    """This user's CSV-synthetic activities, keyed by start_time_key()."""
    rows: list[dict] = []
    page = 1000
    offset = 0
    while True:
        resp = (
            db.table("garmin_activities")
            .select("id, garmin_activity_id, start_time")
            .eq("user_id", user_id)
            .gte("garmin_activity_id", NATIVE_ID_MAX)
            .range(offset, offset + page - 1)
            .execute()
        )
        rows.extend(resp.data or [])
        if len(resp.data or []) < page:
            break
        offset += page
    by_start = {}
    for row in rows:
        key = start_time_key(row.get("start_time"))
        if key is not None:
            by_start[key] = row
    return by_start


def adopt_synthetic_row(db, synthetic: dict, native_id: int) -> None:
    """Turns a CSV-synthetic row into the native activity by re-keying its
    garmin_activity_id. planned_sessions.garmin_activity_id follows through
    ON UPDATE CASCADE (supabase/schema.sql), so any session linked to the CSV
    copy now points at the native id — in one statement, never half-done.
    The native upsert that follows then overwrites it with Garmin's own
    values; CSV-only columns (cadence, ground contact, ...) are kept, since
    the native row doesn't carry them."""
    db.table("garmin_activities").update({"garmin_activity_id": native_id}).eq("id", synthetic["id"]).execute()


def normalize_laps(splits: dict) -> list[dict]:
    """garminconnect get_activity_splits() lapDTOs → the compact shape stored in
    garmin_activities.laps (see ActivityLap in lib/planner/completion.ts)."""
    laps = []
    for i, lap in enumerate((splits or {}).get("lapDTOs") or []):
        distance = lap.get("distance")
        duration = lap.get("duration")
        laps.append(
            {
                "index": lap.get("lapIndex", i + 1),
                "durationSeconds": round(duration, 1) if duration else None,
                "distanceMeters": round(distance, 1) if distance else None,
                "avgHr": round(lap["averageHR"]) if lap.get("averageHR") else None,
                "maxHr": round(lap["maxHR"]) if lap.get("maxHR") else None,
                "avgPaceSecPerKm": pace_sec_per_km(distance or 0, duration or 0),
                "intensityType": lap.get("intensityType"),
            }
        )
    return laps


def activities_needing_laps(db, user_id: str) -> list[int]:
    """Native ids of activities matched to a non-fartlek quality session whose
    laps aren't stored yet — the only activities --fetch-laps ever touches."""
    sessions = (
        db.table("planned_sessions")
        .select("garmin_activity_id, variant")
        .eq("user_id", user_id)
        .eq("completed", True)
        .in_("session_type", ["threshold", "vo2max"])
        .not_.is_("garmin_activity_id", "null")
        .execute()
    ).data or []
    ids = sorted(
        {
            s["garmin_activity_id"]
            for s in sessions
            if s.get("variant") != "fartlek" and s["garmin_activity_id"] < NATIVE_ID_MAX
        }
    )
    if not ids:
        return []
    missing = (
        db.table("garmin_activities")
        .select("garmin_activity_id")
        .eq("user_id", user_id)
        .in_("garmin_activity_id", ids)
        .is_("laps", "null")
        .order("start_time", desc=True)
        .execute()
    ).data or []
    return [row["garmin_activity_id"] for row in missing]


def fetch_laps(api, db, user_id: str, token_payload: dict | None, cooldown_minutes: int) -> dict:
    """Fetches and stores splits for activities_needing_laps(), newest first,
    capped per run and paced — never a bulk fetch across history. Stops at
    the first rate limit and records a cooldown, like the main sync."""
    max_per_run = int(os.environ.get("LAPS_MAX_PER_RUN", "10"))
    delay_s = float(os.environ.get("LAPS_DELAY_SECONDS", "2"))
    pending = activities_needing_laps(db, user_id)
    todo = pending[:max_per_run]
    log.info("Laps: %d quality-matched activit%s without laps; fetching %d.",
             len(pending), "y" if len(pending) == 1 else "ies", len(todo))

    fetched = errors = 0
    for i, activity_id in enumerate(todo):
        if i > 0:
            time.sleep(delay_s)
        try:
            splits = api.get_activity_splits(str(activity_id))
        except Exception as exc:  # noqa: BLE001
            if is_rate_limited(exc):
                until = datetime.now(timezone.utc) + timedelta(minutes=cooldown_minutes)
                record_cooldown(db, user_id, until, existing_token_payload=token_payload)
                log.error("Rate limited by Garmin while fetching laps: %s. Cooldown until %s.", exc, until.isoformat())
                return {"laps_fetched": fetched, "laps_errors": errors + 1, "laps_pending": len(pending) - fetched, "rate_limited": True}
            log.warning("Failed to fetch laps for activity %s: %s", activity_id, exc)
            errors += 1
            continue
        # An empty list is stored too, so an activity without laps isn't re-fetched.
        db.table("garmin_activities").update({"laps": normalize_laps(splits)}).eq(
            "garmin_activity_id", activity_id
        ).execute()
        fetched += 1

    return {"laps_fetched": fetched, "laps_errors": errors, "laps_pending": len(pending) - fetched}


def do_login(api, token_payload: dict | None) -> dict:
    """Resume from `token_payload` if present and usable, otherwise fall back
    to a credential login. Returns the login-counter state (see
    install_login_counter). Raises whatever api.login() raises, with the
    per-strategy warnings captured during the attempt attached as
    `.garmin_warning_messages` — callers pass both to classify_login_failure()."""
    login_state = install_login_counter(api)
    tokenstore = json.dumps(token_payload) if token_payload else None
    if tokenstore:
        log.info("Attempting to resume session from stored tokens…")
    with capture_garmin_warnings() as handler:
        try:
            api.login(tokenstore=tokenstore)
        except Exception as exc:
            exc.garmin_warning_messages = list(handler.messages)
            raise
    if login_state["count"] == 0:
        log.info("Resumed session from stored tokens — no credential login needed.")
    return login_state


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--user-id",
        help="UUID to link each activity to a users row (overrides USER_ID env var).",
    )
    parser.add_argument(
        "--allow-anonymous",
        action="store_true",
        help="Explicitly allow inserting rows with no user_id. Use only for scratch/debug runs.",
    )
    parser.add_argument(
        "--login",
        action="store_true",
        help=(
            "One-time interactive bootstrap: perform a credential login (prompting for an MFA "
            "code if needed), persist the resulting tokens to Supabase, and exit — no activity "
            "sync. Run this once per user before relying on normal (token-only) runs."
        ),
    )
    parser.add_argument(
        "--fetch-laps",
        action="store_true",
        help=(
            "Instead of syncing activities, fetch per-lap splits for activities matched to "
            "quality sessions that don't have them yet (capped + paced, see LAPS_MAX_PER_RUN / "
            "LAPS_DELAY_SECONDS). Run after session matching — see app/api/garmin/sync/route.ts."
        ),
    )
    args = parser.parse_args()
    if args.fetch_laps and args.login:
        parser.error("--fetch-laps and --login are separate runs.")

    if garminconnect is None:
        log.error("garminconnect not installed. Run: pip install -r scripts/requirements.txt")
        sys.exit(1)

    # garminconnect.Garmin.login() falls back to a GARMINTOKENS env var when we pass
    # tokenstore=None. We always decide the tokenstore explicitly (Supabase or nothing),
    # so drop this to avoid silently loading a leftover local/old-format token file —
    # exactly the incompatible pre-upgrade tokens this migration moves away from.
    os.environ.pop("GARMINTOKENS", None)

    try:
        from supabase import create_client
    except ImportError:
        log.error("supabase not installed. Run: pip install -r scripts/requirements.txt")
        sys.exit(1)

    username = require_env("GARMIN_USERNAME")
    password = require_env("GARMIN_PASSWORD")
    supabase_url = require_env("SUPABASE_URL")
    supabase_key = require_env("SUPABASE_SERVICE_KEY")
    user_id = args.user_id or os.environ.get("USER_ID") or None
    if not user_id and not args.allow_anonymous:
        log.error(
            "No user_id supplied. Pass --user-id <uuid>, set USER_ID, or pass "
            "--allow-anonymous to explicitly insert rows with no owner."
        )
        sys.exit(1)
    if args.login and not user_id:
        log.error("--login requires a real --user-id — there is nowhere to persist tokens without one.")
        sys.exit(1)
    cooldown_minutes = int(os.environ.get("GARMIN_COOLDOWN_MINUTES", "60"))
    days_back = int(os.environ.get("DAYS_BACK", "1825"))

    db = create_client(supabase_url, supabase_key)

    token_payload: dict | None = None
    if user_id:
        auth_state = load_auth_state(db, user_id)
        token_payload = auth_state["token_payload"]
        cooldown_until = auth_state["cooldown_until"]
        if cooldown_until and cooldown_until > datetime.now(timezone.utc):
            log.error(cooldown_remaining_message(cooldown_until))
            sys.exit(1)
    else:
        log.warning("Running anonymously (--allow-anonymous) — no token/cooldown persistence this run.")

    # ─── --login: one-time bootstrap, credential login only, then exit ────
    if args.login:
        log.info("Bootstrap login for %s …", username)
        api = garminconnect.Garmin(username, password, prompt_mfa=lambda: input("MFA code: "))
        try:
            login_state = do_login(api, token_payload=None)  # always force a fresh credential login
        except Exception as exc:
            reason, message = classify_login_failure(exc, getattr(exc, "garmin_warning_messages", []))
            log.error(message)
            if reason == "rate_limited":
                until = datetime.now(timezone.utc) + timedelta(minutes=cooldown_minutes)
                record_cooldown(db, user_id, until, existing_token_payload=token_payload)
                log.error("Cooldown recorded until %s. Not retrying.", until.isoformat())
            elif reason == "auth_failed":
                log.error("If you're sure the password is right and have 2FA enabled, this flag already handles MFA prompts — try again.")
            sys.exit(1)
        save_tokens(db, user_id, json.loads(api.client.dumps()))
        log.info("Bootstrap login succeeded (%d credential login). Tokens saved.", login_state["count"])
        print(json.dumps({"ok": True, "credential_logins": login_state["count"]}))
        return

    # ─── Normal sync run ────────────────────────────────────────────────
    log.info("Connecting to Garmin Connect as %s …", username)
    api = garminconnect.Garmin(username, password)

    try:
        login_state = do_login(api, token_payload)
    except Exception as exc:
        # classify_login_failure() checks is_rate_limited() (type + exception-chain match)
        # FIRST, then falls back to the per-strategy warnings do_login() captured, and only
        # then treats a clean GarminConnectAuthenticationError as a credentials problem —
        # see its docstring for why a naive isinstance() check on its own would misfire.
        reason, message = classify_login_failure(exc, getattr(exc, "garmin_warning_messages", []))
        log.error(message)
        if reason == "rate_limited":
            until = datetime.now(timezone.utc) + timedelta(minutes=cooldown_minutes)
            if user_id:
                record_cooldown(db, user_id, until, existing_token_payload=token_payload)
            log.error("Cooldown recorded until %s. Not retrying — every further Garmin call this run is skipped.", until.isoformat())
        elif reason == "auth_failed":
            log.error("If you have 2FA enabled, run: python scripts/sync_garmin.py --login --user-id <uuid>")
        sys.exit(1)

    log.info("Logged in.")
    if user_id:
        save_tokens(db, user_id, json.loads(api.client.dumps()))

    if args.fetch_laps:
        if not user_id:
            log.error("--fetch-laps requires a user id.")
            sys.exit(1)
        summary = fetch_laps(api, db, user_id, json.loads(api.client.dumps()), cooldown_minutes)
        try:
            save_tokens(db, user_id, json.loads(api.client.dumps()))
        except Exception as exc:  # noqa: BLE001
            log.debug("Post-fetch token save skipped: %s", exc)
        summary["credential_logins"] = login_state["count"]
        log.info("Done — %s", summary)
        print(json.dumps(summary))
        if summary.get("rate_limited"):
            sys.exit(1)
        return

    if login_state["count"] > 0:
        log.warning(
            "%d credential login(s) this run — expected 0 once tokens are established. "
            "If this keeps happening on every run, token persistence has regressed.",
            login_state["count"],
        )

    end_date = date.today()
    start_date = end_date - timedelta(days=days_back)

    log.info("Fetching running activities from %s to %s …", start_date, end_date)
    try:
        activities = api.get_activities_by_date(
            start_date.isoformat(), end_date.isoformat(), activitytype="running"
        )
    except Exception as exc:
        if is_rate_limited(exc):
            until = datetime.now(timezone.utc) + timedelta(minutes=cooldown_minutes)
            if user_id:
                record_cooldown(db, user_id, until, existing_token_payload=json.loads(api.client.dumps()))
            log.error("Rate limited by Garmin while fetching activities: %s", exc)
            log.error("Cooldown recorded until %s. Not retrying.", until.isoformat())
            sys.exit(1)
        raise
    log.info("Found %d running activities.", len(activities))

    # Best-effort: persist again in case a token refresh happened during the
    # fetch above (api.client._run_request() auto-refreshes on expiry).
    if user_id:
        try:
            save_tokens(db, user_id, json.loads(api.client.dumps()))
        except Exception as exc:  # noqa: BLE001
            log.debug("Post-fetch token save skipped: %s", exc)

    inserted = skipped = errors = replaced = 0

    # A CSV import may already hold a synthetic copy of a run at the same
    # start_time; the (user_id, start_time) unique constraint would reject the
    # native insert, so that row is re-keyed to the native id first.
    synthetic_by_start = load_synthetic_by_start(db, user_id) if user_id else {}

    for act in activities:
        garmin_id = act.get("activityId")
        if not garmin_id:
            continue

        distance_m = act.get("distance") or 0
        duration_s = act.get("duration") or 0
        avg_hr = act.get("averageHR")
        max_hr = act.get("maxHR")
        elevation = act.get("elevationGain")
        vo2max = act.get("vO2MaxValue")
        start_time = act.get("startTimeLocal") or act.get("startTimeGMT")
        activity_type = (act.get("activityType") or {}).get("typeKey", "running")

        row: dict = {
            "garmin_activity_id": int(garmin_id),
            "activity_type": activity_type,
            "start_time": start_time,
            "duration_seconds": int(duration_s) if duration_s else None,
            "distance_meters": float(distance_m) if distance_m else None,
            "avg_pace_sec_per_km": pace_sec_per_km(distance_m, duration_s),
            "avg_heart_rate": int(avg_hr) if avg_hr else None,
            "max_heart_rate": int(max_hr) if max_hr else None,
            "elevation_gain_m": float(elevation) if elevation else None,
            "vo2max_estimate": float(vo2max) if vo2max else None,
            "raw_data": act,
        }
        if user_id:
            row["user_id"] = user_id

        synthetic = synthetic_by_start.pop(start_time_key(start_time), None) if start_time else None
        if synthetic is not None:
            try:
                adopt_synthetic_row(db, synthetic, int(garmin_id))
                replaced += 1
                log.info("Replaced CSV copy %s with native activity %s.", synthetic["garmin_activity_id"], garmin_id)
            except Exception as exc:  # noqa: BLE001
                log.warning(
                    "Could not replace CSV copy %s with native activity %s (is the ON UPDATE CASCADE "
                    "migration in supabase/schema.sql applied?): %s",
                    synthetic["garmin_activity_id"], garmin_id, exc,
                )
                errors += 1
                continue

        try:
            result = (
                db.table("garmin_activities")
                .upsert(row, on_conflict="garmin_activity_id")
                .execute()
            )
            if result.data:
                inserted += 1
            else:
                skipped += 1
        except Exception as exc:  # noqa: BLE001
            log.warning("Failed to upsert activity %s: %s", garmin_id, exc)
            errors += 1

    summary = {
        "inserted": inserted,
        "replaced_csv_copies": replaced,
        "skipped": skipped,
        "errors": errors,
        "credential_logins": login_state["count"],
    }
    log.info("Done — %s", summary)
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
