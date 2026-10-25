import { NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
import { matchGarminActivitiesForUser, reevaluateCompletedSessionsForUser } from "@/lib/garmin/matchSessions";
import { raiseHrMaxFromObserved } from "@/lib/athlete/profile";
import { requireUser } from "@/lib/auth/server";

interface ScriptResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when Python itself couldn't be started. */
  spawnError?: Error;
}

/**
 * Runs scripts/sync_garmin.py with the given extra args for this user. This is where the service-role key is
 * still handed out: the script bulk-writes activities from its own process, outside any user session. The
 * route only gets here after requireUser(), and passes the authenticated user's id (never a client-supplied one).
 */
function runSyncScript(userId: string, args: string[]): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const scriptPath = path.join(process.cwd(), "scripts", "sync_garmin.py");

    const proc = spawn("python", [scriptPath, ...args], {
      env: {
        ...process.env,
        GARMIN_USERNAME: process.env.GARMIN_USERNAME ?? "",
        GARMIN_PASSWORD: process.env.GARMIN_PASSWORD ?? "",
        SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
        SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
        USER_ID: userId,
      },
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
    proc.on("error", (err) => resolve({ code: null, stdout, stderr, spawnError: err }));
  });
}

function parseJson(stdout: string): Record<string, unknown> {
  try {
    return JSON.parse(stdout);
  } catch {
    return { output: stdout };
  }
}

/**
 * GET /api/garmin/sync   (signed-in user only)
 * 1. Spawns scripts/sync_garmin.py to import activities.
 * 2. Raises users.hr_max if an activity recorded a higher max HR (never lowers it).
 * 3. Links new activities to planned sessions.
 * 4. Spawns sync_garmin.py --fetch-laps: splits for activities matched to
 *    quality sessions that don't have them yet (capped + paced), so their
 *    work reps can be scored.
 * 5. Re-scores every completed session (new laps, refreshed activity data,
 *    zones moved by step 2).
 * Steps 2-5 are best-effort: a failure there is reported, not fatal.
 */
export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  const { userId, db } = auth;

  const sync = await runSyncScript(userId, []);
  if (sync.spawnError) {
    return NextResponse.json(
      {
        ok: false,
        error: `Could not start Python. Is it installed? ${sync.spawnError.message}`,
        hint: "Ensure python is in PATH and scripts/requirements.txt is installed.",
      },
      { status: 500 }
    );
  }
  if (sync.code !== 0) {
    return NextResponse.json({ ok: false, error: sync.stderr || "Script exited with code " + sync.code }, { status: 500 });
  }
  const syncResult = parseJson(sync.stdout);

  let hrMax: Record<string, unknown>;
  try {
    hrMax = await raiseHrMaxFromObserved(db, userId);
  } catch (err) {
    hrMax = { skipped: true, error: err instanceof Error ? err.message : String(err) };
    console.warn(`Skipped observed hr_max update for user ${userId}:`, hrMax.error);
  }

  let completedSessions = 0;
  let completionError: string | null = null;
  try {
    completedSessions = await matchGarminActivitiesForUser(db, userId);
  } catch (err) {
    completionError = err instanceof Error ? err.message : String(err);
    console.warn(`Skipped session-completion matching for user ${userId}:`, completionError);
  }

  const lapsRun = await runSyncScript(userId, ["--fetch-laps"]);
  const laps =
    lapsRun.code === 0
      ? parseJson(lapsRun.stdout)
      : { skipped: true, error: lapsRun.spawnError?.message || lapsRun.stderr.trim().split("\n").pop() || `exit ${lapsRun.code}` };
  if (lapsRun.code !== 0) console.warn(`Lap fetch failed for user ${userId}:`, laps);

  let reevaluated = 0;
  let reevaluationError: string | null = null;
  try {
    reevaluated = await reevaluateCompletedSessionsForUser(db, userId);
  } catch (err) {
    reevaluationError = err instanceof Error ? err.message : String(err);
    console.warn(`Skipped re-evaluation of completed sessions for user ${userId}:`, reevaluationError);
  }

  return NextResponse.json({
    ok: true,
    ...syncResult,
    hrMax,
    completion: completionError ? { skipped: true, error: completionError } : { matched: completedSessions },
    laps,
    reevaluation: reevaluationError ? { skipped: true, error: reevaluationError } : { reevaluated },
  });
}
