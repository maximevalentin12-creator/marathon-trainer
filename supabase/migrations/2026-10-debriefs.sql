-- ════════════════════════════════════════════════════════════════════════════
-- Debriefs + injury episodes — run in the Supabase SQL Editor. Idempotent: re-running is safe.
-- subjective_entries is left untouched (still readable for history).
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS debriefs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  garmin_activity_id  BIGINT REFERENCES garmin_activities(garmin_activity_id) ON DELETE SET NULL,
  planned_session_id  UUID REFERENCES planned_sessions(id) ON DELETE SET NULL,
  date                DATE NOT NULL,
  effort              SMALLINT NOT NULL CHECK (effort BETWEEN 1 AND 10),
  legs                SMALLINT NOT NULL CHECK (legs BETWEEN 1 AND 5),
  energy              SMALLINT NOT NULL CHECK (energy BETWEEN 1 AND 5),
  enjoyment           SMALLINT NOT NULL CHECK (enjoyment BETWEEN 1 AND 5),
  has_pain            BOOLEAN NOT NULL DEFAULT FALSE,
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- One debrief per activity (debriefs without an activity are not constrained).
CREATE UNIQUE INDEX IF NOT EXISTS debriefs_activity_uniq ON debriefs(garmin_activity_id) WHERE garmin_activity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS debriefs_user_date_idx ON debriefs(user_id, date);

CREATE TABLE IF NOT EXISTS injury_episodes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  zone            TEXT NOT NULL CHECK (zone IN ('foot','ankle','shin','calf','knee','thigh','hip','back','other')),
  side            TEXT NOT NULL CHECK (side IN ('left','right','both')),
  started_on      DATE NOT NULL,
  resolved_on     DATE,
  peak_intensity  SMALLINT NOT NULL CHECK (peak_intensity BETWEEN 0 AND 10),
  affects_gait    BOOLEAN NOT NULL DEFAULT FALSE,
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS injury_episodes_user_idx ON injury_episodes(user_id, resolved_on);

CREATE TABLE IF NOT EXISTS injury_reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  debrief_id    UUID NOT NULL REFERENCES debriefs(id) ON DELETE CASCADE,
  episode_id    UUID NOT NULL REFERENCES injury_episodes(id) ON DELETE CASCADE,
  intensity     SMALLINT NOT NULL CHECK (intensity BETWEEN 0 AND 10),
  onset         TEXT NOT NULL CHECK (onset IN ('before','during','after')),
  affects_gait  BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS injury_reports_debrief_idx ON injury_reports(debrief_id);
CREATE INDEX IF NOT EXISTS injury_reports_episode_idx ON injury_reports(episode_id);

ALTER TABLE debriefs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE injury_episodes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE injury_reports   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own debriefs" ON debriefs;
CREATE POLICY "own debriefs" ON debriefs
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "own injury episodes" ON injury_episodes;
CREATE POLICY "own injury episodes" ON injury_episodes
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "own injury reports" ON injury_reports;
CREATE POLICY "own injury reports" ON injury_reports
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
