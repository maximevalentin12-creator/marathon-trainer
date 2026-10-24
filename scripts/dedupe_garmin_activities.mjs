// One-off cleanup: merges duplicate garmin_activities rows.
//
// Each run could exist twice with the same (user_id, start_time): once with a
// native Garmin id (< 1e12, from scripts/sync_garmin.py) and once with a CSV
// synthetic id (from syntheticActivityId() in lib/garmin/parseCsv.ts — a 51-bit
// hash, so usually >= 1e14 but not always: treat anything >= 1e12 as synthetic).
// For each such pair this script:
//   1. copies onto the native row every column it lacks (null) that the
//      synthetic row has,
//   2. repoints every reference (see REFERENCES) from the synthetic id to the
//      native id,
//   3. deletes the synthetic row.
//
// Dry run by default — prints what it would change and writes nothing:
//   node --env-file=.env.local scripts/dedupe_garmin_activities.mjs
// Apply:
//   node --env-file=.env.local scripts/dedupe_garmin_activities.mjs --apply
//
// Idempotent: each pair is applied in the order above, so an interrupted run
// can simply be re-run. Afterwards, apply the "one activity per start time"
// migration at the end of supabase/schema.sql.

import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");

const NATIVE_ID_MAX = 1e12; // native Garmin ids are below this
const SYNTHETIC_ID_MIN = NATIVE_ID_MAX; // CSV synthetic ids are uniform over [0, 2^51)

/** Every column that stores a garmin_activities.garmin_activity_id. */
const REFERENCES = [{ table: "planned_sessions", column: "garmin_activity_id" }];

/** Never copied from the synthetic row: identity/bookkeeping columns. */
const NON_MERGEABLE_COLUMNS = new Set(["id", "garmin_activity_id", "user_id", "start_time", "created_at"]);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — run with --env-file=.env.local.");
  process.exit(1);
}
const db = createClient(url, serviceKey);

async function fetchAll(table, columns, build = (q) => q) {
  const PAGE = 1000;
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(db.from(table).select(columns)).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

const isNative = (id) => id < NATIVE_ID_MAX;
const isSynthetic = (id) => id >= SYNTHETIC_ID_MIN;
const isMissing = (v) => v === null || v === undefined;

function fmt(v) {
  if (v !== null && typeof v === "object") return "<json>";
  return JSON.stringify(v);
}

async function main() {
  console.log(APPLY ? "=== APPLY MODE — changes will be written ===\n" : "=== DRY RUN — nothing will be written ===\n");

  const activities = await fetchAll("garmin_activities", "*", (q) => q.order("start_time", { ascending: true }));
  console.log(`garmin_activities: ${activities.length} rows`);

  const groups = new Map();
  for (const a of activities) {
    if (a.start_time == null) continue;
    const key = `${a.user_id}|${new Date(a.start_time).getTime()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }

  const pairs = [];
  const anomalies = [];
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const natives = rows.filter((r) => isNative(r.garmin_activity_id));
    const synthetics = rows.filter((r) => isSynthetic(r.garmin_activity_id));
    if (rows.length === 2 && natives.length === 1 && synthetics.length === 1) {
      pairs.push({ native: natives[0], synthetic: synthetics[0] });
    } else {
      anomalies.push(rows);
    }
  }
  console.log(`duplicate native/synthetic pairs: ${pairs.length}`);
  console.log(`other duplicate groups (left untouched): ${anomalies.length}\n`);

  // Every reference to any activity involved in a pair.
  const involvedIds = new Set(pairs.flatMap((p) => [p.native.garmin_activity_id, p.synthetic.garmin_activity_id]));
  const refsById = new Map();
  for (const ref of REFERENCES) {
    const rows = await fetchAll(ref.table, `id, ${ref.column}`, (q) => q.not(ref.column, "is", null));
    for (const r of rows) {
      const activityId = r[ref.column];
      if (!involvedIds.has(activityId)) continue;
      if (!refsById.has(activityId)) refsById.set(activityId, []);
      refsById.get(activityId).push({ ...ref, rowId: r.id });
    }
  }

  const sessionRows = await fetchAll("planned_sessions", "id, planned_date, session_label, completed");
  const sessionById = new Map(sessionRows.map((s) => [s.id, s]));

  let totalFilled = 0;
  let totalRepointed = 0;
  let conflicts = 0;
  const actionable = [];

  for (const { native, synthetic } of pairs) {
    const nativeRefs = refsById.get(native.garmin_activity_id) ?? [];
    const syntheticRefs = refsById.get(synthetic.garmin_activity_id) ?? [];

    const fill = {};
    for (const [col, value] of Object.entries(synthetic)) {
      if (NON_MERGEABLE_COLUMNS.has(col)) continue;
      if (isMissing(native[col]) && !isMissing(value)) fill[col] = value;
    }

    const distanceKm = native.distance_meters != null ? (native.distance_meters / 1000).toFixed(2) : "?";
    console.log(`• ${native.start_time}  ${distanceKm} km  user ${native.user_id}`);
    console.log(`    keep   native    ${native.garmin_activity_id}`);
    console.log(`    delete synthetic ${synthetic.garmin_activity_id}`);

    // Both copies referenced: repointing would link two rows to one activity.
    const conflictingTables = syntheticRefs.filter((s) =>
      nativeRefs.some((n) => n.table === s.table && n.column === s.column)
    );
    if (conflictingTables.length > 0) {
      conflicts++;
      console.log(`    !! SKIPPED — both copies are referenced (native by ${nativeRefs.length}, synthetic by ${syntheticRefs.length}); resolve by hand`);
      continue;
    }

    const fillCols = Object.keys(fill);
    if (fillCols.length > 0) {
      console.log(`    copy onto native: ${fillCols.map((c) => `${c}=${fmt(fill[c])}`).join(", ")}`);
    }
    for (const r of syntheticRefs) {
      const s = r.table === "planned_sessions" ? sessionById.get(r.rowId) : null;
      const label = s ? ` (${s.planned_date} "${s.session_label ?? ""}"${s.completed ? ", completed" : ""})` : "";
      console.log(`    repoint ${r.table}.${r.column} on row ${r.rowId}${label}`);
    }
    if (nativeRefs.length > 0 && syntheticRefs.length === 0) {
      console.log(`    (native already referenced by ${nativeRefs.length} row(s) — nothing to repoint)`);
    }

    totalFilled += fillCols.length;
    totalRepointed += syntheticRefs.length;
    actionable.push({ native, synthetic, fill, syntheticRefs });
  }

  for (const rows of anomalies) {
    console.log(`\n?? unhandled duplicate group at ${rows[0].start_time} (user ${rows[0].user_id}):`);
    for (const r of rows) console.log(`    garmin_activity_id ${r.garmin_activity_id}`);
  }

  console.log("\n--- summary ---");
  console.log(`pairs to merge:          ${actionable.length}`);
  console.log(`pairs skipped (conflict): ${conflicts}`);
  console.log(`columns copied to native: ${totalFilled}`);
  console.log(`references repointed:     ${totalRepointed}`);
  console.log(`synthetic rows deleted:   ${actionable.length}`);
  console.log(`garmin_activities after:  ${activities.length - actionable.length} rows`);

  if (!APPLY) {
    console.log("\nDry run only. Re-run with --apply to write these changes.");
    return;
  }

  for (const { native, synthetic, fill, syntheticRefs } of actionable) {
    if (Object.keys(fill).length > 0) {
      const { error } = await db.from("garmin_activities").update(fill).eq("id", native.id);
      if (error) throw new Error(`fill native ${native.garmin_activity_id}: ${error.message}`);
    }
    for (const r of syntheticRefs) {
      const { error } = await db
        .from(r.table)
        .update({ [r.column]: native.garmin_activity_id })
        .eq("id", r.rowId)
        .eq(r.column, synthetic.garmin_activity_id);
      if (error) throw new Error(`repoint ${r.table} ${r.rowId}: ${error.message}`);
    }
    const { error } = await db.from("garmin_activities").delete().eq("id", synthetic.id);
    if (error) throw new Error(`delete synthetic ${synthetic.garmin_activity_id}: ${error.message}`);
  }
  console.log(`\nApplied: merged ${actionable.length} pairs.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
