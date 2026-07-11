import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import types
import unittest
from argparse import Namespace
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
HELPER_PATH = ROOT / "scripts" / "ytmusic_helper.py"


spec = importlib.util.spec_from_file_location("ytmusic_helper", HELPER_PATH)
ytmusic_helper = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(ytmusic_helper)


class FixedDateTime(datetime):
    current = datetime(2026, 3, 1, 8, 30, tzinfo=timezone.utc)

    @classmethod
    def now(cls, tz=None):
        if tz is None:
            return cls.current.replace(tzinfo=None)
        return cls.current.astimezone(tz)


def resolve(raw, now=None):
    return ytmusic_helper._resolve_played_at(raw, now or FixedDateTime.current)


class PlayedAtParserTests(unittest.TestCase):
    def test_new_bucket_labels_use_deterministic_utc_representatives(self):
        now = datetime(2026, 3, 1, 8, 30, tzinfo=timezone.utc)

        self.assertEqual(resolve(" This Week ", now), "2026-02-25T12:00:00+00:00")
        self.assertEqual(resolve("THIS MONTH", now), "2026-03-15T12:00:00+00:00")
        self.assertEqual(resolve("January", now), "2026-01-15T12:00:00+00:00")
        self.assertEqual(resolve("Mar", now), "2026-03-15T12:00:00+00:00")
        self.assertEqual(resolve("April", now), "2025-04-15T12:00:00+00:00")
        self.assertEqual(resolve("2024", now), "2024-07-02T12:00:00+00:00")
        self.assertEqual(resolve("2025", now), "2025-07-02T12:00:00+00:00")

    def test_every_month_name_and_abbreviation_is_supported(self):
        now = datetime(2026, 12, 31, 23, 59, tzinfo=timezone.utc)
        months = [
            ("January", "Jan", "2026-01-15T12:00:00+00:00"),
            ("February", "Feb", "2026-02-15T12:00:00+00:00"),
            ("March", "Mar", "2026-03-15T12:00:00+00:00"),
            ("April", "Apr", "2026-04-15T12:00:00+00:00"),
            ("May", "May", "2026-05-15T12:00:00+00:00"),
            ("June", "Jun", "2026-06-15T12:00:00+00:00"),
            ("July", "Jul", "2026-07-15T12:00:00+00:00"),
            ("August", "Aug", "2026-08-15T12:00:00+00:00"),
            ("September", "Sep", "2026-09-15T12:00:00+00:00"),
            ("October", "Oct", "2026-10-15T12:00:00+00:00"),
            ("November", "Nov", "2026-11-15T12:00:00+00:00"),
            ("December", "Dec", "2026-12-15T12:00:00+00:00"),
        ]
        for full, abbr, expected in months:
            with self.subTest(label=full):
                self.assertEqual(resolve(full, now), expected)
            with self.subTest(label=abbr):
                self.assertEqual(resolve(abbr, now), expected)

    def test_absolute_inputs_normalize_and_invalid_inputs_return_none(self):
        now = datetime(2026, 3, 1, 8, 30, tzinfo=timezone.utc)

        self.assertEqual(resolve("2026-02-01T23:00:00Z", now), "2026-02-01T23:00:00+00:00")
        self.assertEqual(resolve("2026-02-02T12:30:00+13:00", now), "2026-02-01T23:30:00+00:00")

        rejected = [
            "2026-02-01T23:00:00",
            "this week maybe",
            "Jan 2026",
            "März",
            "0000",
            "10000",
            "202",
            "",
            None,
        ]
        for raw in rejected:
            with self.subTest(raw=raw):
                self.assertIsNone(resolve(raw, now))


class FetchCommandTests(unittest.TestCase):
    def run_fetch(self, items, since=None):
        fake_module = types.ModuleType("ytmusicapi")

        class FakeYTMusic:
            def __init__(self, *args, **kwargs):
                pass

            def get_history(self):
                return [dict(item) for item in items]

        class FakeOAuthCredentials:
            def __init__(self, *args, **kwargs):
                pass

        fake_module.YTMusic = FakeYTMusic
        fake_module.OAuthCredentials = FakeOAuthCredentials

        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as token_file:
            json.dump({"_auth_type": "browser"}, token_file)
            token_path = token_file.name

        stdout = io.StringIO()
        stderr = io.StringIO()
        args = Namespace(token_file=token_path, since=since, client_id=None, client_secret=None)

        with mock.patch.dict(sys.modules, {"ytmusicapi": fake_module}):
            with mock.patch.object(ytmusic_helper, "datetime", FixedDateTime):
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    ytmusic_helper.cmd_fetch(args)

        output = json.loads(stdout.getvalue())
        diagnostics = [
            json.loads(line)
            for line in stderr.getvalue().splitlines()
            if line.strip()
        ]
        return output, diagnostics

    def test_cmd_fetch_preserves_supported_rows_and_reports_unsupported_once(self):
        output, diagnostics = self.run_fetch([
            {"videoId": "week", "title": "Week", "played": "This week"},
            {"videoId": "month", "title": "Month", "played": "March"},
            {"videoId": "bad", "title": "Bad", "played": "März"},
        ])

        self.assertEqual([item["videoId"] for item in output["items"]], ["week", "month"])
        self.assertEqual(output["items"][0]["played"], "2026-02-25T12:00:00+00:00")
        self.assertEqual(output["items"][0]["played_raw"], "This week")
        self.assertEqual(output["items"][0]["played_precision"], "week")
        self.assertEqual(output["items"][0]["played_bucket"], "this week")
        self.assertFalse(output["items"][0]["played_cursor_eligible"])
        self.assertEqual(output["items"][1]["played_precision"], "month")
        self.assertEqual(output["items"][1]["played_bucket"], "march")
        self.assertFalse(output["items"][1]["played_cursor_eligible"])
        self.assertEqual(diagnostics, [{
            "skipped": {
                "reason": "unparsable played bucket",
                "played": "März",
                "videoId": "bad",
            }
        }])

    def test_since_keeps_later_items_from_same_coarse_bucket(self):
        output, diagnostics = self.run_fetch(
            [
                {"videoId": "new-week", "title": "New Week", "played": "This week"},
                {"videoId": "old-absolute", "title": "Old Absolute", "played": "2026-02-24T12:00:00Z"},
            ],
            since="2026-02-25T12:00:00+00:00",
        )

        self.assertEqual(diagnostics, [])
        self.assertEqual([item["videoId"] for item in output["items"]], ["new-week"])


if __name__ == "__main__":
    unittest.main()
