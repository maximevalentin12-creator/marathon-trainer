"""Log-hygiene tests for sync_garmin.py — it runs in public CI logs, so nothing sensitive may reach them.
Run:  python -m unittest scripts/test_sync_garmin.py   (needs no network and no Garmin account)
"""

import io
import logging
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("GARMIN_NO_CREDENTIAL_LOGIN", "1")
import sync_garmin as s  # noqa: E402


class Coded(Exception):
    code = "23505"


class LogHygiene(unittest.TestCase):
    def test_safe_error_redacts_identifiers(self):
        raw = (
            "failed for jean.dupont@gmail.com at https://sso.garmin.com/x?ticket=abc Bearer eyJabc.def.ghi "
            "user 8aaa8e1e-416c-4e7a-aed1-d1bdbc2ef9e8 activity 12345678901 ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        )
        out = s.safe_error(Exception(raw))
        for leaked in ("jean.dupont", "garmin.com", "eyJ", "8aaa8e1e", "12345678901", "ABCDEFGH"):
            self.assertNotIn(leaked, out)

    def test_db_error_never_quotes_the_row(self):
        out = s.db_error(Coded("Key (user_id, start_time)=(8aaa8e1e, 2026-10-18T08:00) already exists"))
        self.assertEqual(out, "Coded (code 23505)")

    def test_third_party_loggers_are_quiet_and_garmin_stays_off_the_console(self):
        self.assertFalse(logging.getLogger("garminconnect").propagate)
        self.assertGreaterEqual(logging.getLogger("httpx").level, logging.ERROR)
        self.assertGreaterEqual(logging.getLogger("httpx").getEffectiveLevel(), logging.ERROR)

    def test_credential_login_is_blocked_in_scheduled_mode(self):
        class Client:
            def login(self, *a, **k):
                raise AssertionError("credentials were sent to Garmin")

        class Api:
            client = Client()

        s.install_login_counter(Api)
        with self.assertRaises(s.CredentialLoginBlocked):
            Api.client.login("user", "pass")

    def test_rate_limit_still_detected(self):
        self.assertTrue(s.is_rate_limited(Exception("Too many login attempts. Please wait")))
        self.assertTrue(s.any_strategy_rate_limited(["portal returned 429: x"]))


if __name__ == "__main__":
    unittest.main()
