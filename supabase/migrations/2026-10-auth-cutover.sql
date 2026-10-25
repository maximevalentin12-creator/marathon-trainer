-- ════════════════════════════════════════════════════════════════════════════
-- Auth cutover — run ONCE in the Supabase SQL Editor (it is idempotent: re-running is safe).
--
-- OPTION CHOSEN: create the Supabase Auth user WITH YOUR EXISTING ID. Every table keys on public.users(id), and
-- none of them references auth.users, so once auth.users holds a row with that same id, auth.uid() already equals
-- the id your data is stored under. Nothing is re-keyed and no row of yours is moved or deleted.
--
-- BEFORE YOU RUN IT
--  1. Table Editor → users → check the email on your row (the one with id 8aaa8e1e-…). That is the e-mail you will
--     sign in with. (Or run:  select email from public.users where id = '8aaa8e1e-416c-4e7a-aed1-d1bdbc2ef9e8';)
--  2. Replace CHANGE-ME-BEFORE-RUNNING below with the password you want. Do not keep it in the editor's saved
--     history afterwards (delete the snippet or overwrite the value once it has run).
--  3. Authentication → Authentication (or "Sign In / Providers") → Email: make sure the provider is ENABLED, and turn
--     OFF "Allow new users to sign up". The anon key is public, so without this anyone could call /auth/v1/signup
--     directly even though the app has no sign-up page. (Run this block first or after — order does not matter.)
--  4. If Authentication → Users already lists an account with your e-mail but a different id, delete it there first
--     (the block stops with a message instead of guessing).
--
-- AFTER IT RUNS
--  - The last query in this file shows every table in `public` with its RLS state and policy count: every row must
--    read rls = true. Paste the result back to me if any row says false.
--  - Deploy the new app, open /login, sign in with the e-mail from step 1 and the password from step 2.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Your auth user, with your existing id ────────────────────────────────

DO $$
DECLARE
  v_id    uuid := '8aaa8e1e-416c-4e7a-aed1-d1bdbc2ef9e8';
  v_pw    text := 'CHANGE-ME-BEFORE-RUNNING';
  v_email text;
BEGIN
  SELECT email INTO v_email FROM public.users WHERE id = v_id;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'No public.users row with id % — nothing to attach the login to.', v_id;
  END IF;

  IF EXISTS (SELECT 1 FROM auth.users WHERE id = v_id) THEN
    RAISE NOTICE 'Auth user % already exists — left untouched (password included).', v_id;
  ELSE
    IF v_pw = 'CHANGE-ME-BEFORE-RUNNING' OR length(v_pw) < 10 THEN
      RAISE EXCEPTION 'Set a real password (10+ characters) in v_pw first.';
    END IF;
    IF EXISTS (SELECT 1 FROM auth.users WHERE lower(email) = lower(v_email)) THEN
      RAISE EXCEPTION 'An auth user with e-mail % already exists under another id. Delete it in Authentication → Users, then re-run.', v_email;
    END IF;

    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change,
      email_change_token_current, phone_change, phone_change_token, reauthentication_token
    ) VALUES (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
      extensions.crypt(v_pw, extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
      '', '', '', '', '', '', '', ''
    );

    INSERT INTO auth.identities (
      id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at
    ) VALUES (
      gen_random_uuid(), v_id, v_id::text, 'email',
      jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true, 'phone_verified', false),
      now(), now(), now()
    );
    RAISE NOTICE 'Created auth user % (%).', v_id, v_email;
  END IF;
END $$;

-- ─── 2. Row Level Security on EVERY table holding user data ──────────────────
-- Exactly one policy per table, for signed-in users only (auth.uid() = the owner), with the same rule for reads and
-- writes. Old policies are dropped first so nothing looser survives under another name. The anon role loses all
-- access. The service-role key bypasses RLS by design (Google webhook + Garmin sync script only).

DO $$
DECLARE
  t record;
  p record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('users',                'id'),
      ('garmin_activities',    'user_id'),
      ('planned_sessions',     'user_id'),
      ('subjective_entries',   'user_id'),
      ('weekly_setups',        'user_id'),
      ('progression_state',    'user_id'),
      ('races',                'user_id'),
      ('shoes',                'user_id'),
      ('garmin_tokens',        'user_id'),
      ('google_oauth_tokens',  'user_id'),
      ('google_calendar_sync', 'user_id')
    ) AS v(tbl, owner_col)
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tbl);

    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = t.tbl LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t.tbl);
    END LOOP;

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (auth.uid() = %I) WITH CHECK (auth.uid() = %I)',
      'own ' || t.tbl, t.tbl, t.owner_col, t.owner_col
    );
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t.tbl);
  END LOOP;
END $$;

-- ─── 3. Check: every table in `public`, its RLS state and policies ───────────
-- rls must be true on every row. A table listed with policies = 0 and rls = true is locked for everyone but the
-- service role (fine for a table the app never reads as a user).

SELECT c.relname                                   AS table_name,
       c.relrowsecurity                            AS rls,
       (SELECT count(*) FROM pg_policies p
         WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relrowsecurity, c.relname;
