// Long-run duration anchor (spec §1): "duréeLongue = durée de la plus longue
// sortie des 12 dernières semaines (Garmin), arrondie à la baisse au multiple
// de 5 min le plus proche, plancher 30 min." Deliberately based on demonstrated
// capacity (longest single run), not average weekly volume — see spec's
// "Correction importante" note.

export interface ActivitySample {
  startTime: Date;
  durationSeconds: number;
  activityType: string | null;
}

function isRunningActivity(activityType: string | null): boolean {
  if (!activityType) return true; // unknown type — don't silently drop it
  return activityType.toLowerCase().includes("running");
}

/** Duration (minutes, unrounded) of the longest run of the 12 weeks before `now`; 0 when there is none. */
export function longestRunMinutes(activities: ActivitySample[], now: Date = new Date()): number {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - 84); // 12 weeks

  const longestSeconds = activities
    .filter((a) => a.startTime >= cutoff && a.durationSeconds > 0 && isRunningActivity(a.activityType))
    .reduce((max, a) => Math.max(max, a.durationSeconds), 0);
  return longestSeconds / 60;
}

export function computeLongRunAnchorMinutes(
  activities: ActivitySample[],
  now: Date = new Date()
): number {
  const longest = longestRunMinutes(activities, now);
  if (longest === 0) return 30;

  const minutes = Math.floor(longest / 5) * 5;
  return Math.max(30, minutes);
}
