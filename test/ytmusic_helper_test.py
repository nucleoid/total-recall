import unittest
from datetime import datetime, timezone

from scripts.ytmusic_helper import _resolve_played_metadata


class YtMusicPlayedMetadataTests(unittest.TestCase):
    def test_today_is_stable_day_bucket_start(self):
        now = datetime(2026, 7, 1, 18, 34, tzinfo=timezone.utc)

        meta = _resolve_played_metadata("Today", now)

        self.assertEqual(meta["played"], "2026-07-01T00:00:00+00:00")
        self.assertEqual(meta["played_precision"], "day")
        self.assertEqual(meta["played_bucket"], "day:2026-07-01")

    def test_in_progress_bucket_never_future_dates(self):
        now = datetime(2026, 7, 1, 8, 15, tzinfo=timezone.utc)

        today = _resolve_played_metadata("Today", now)
        this_week = _resolve_played_metadata("This week", now)
        this_month = _resolve_played_metadata("This month", now)
        this_year = _resolve_played_metadata("This year", now)

        for meta in (today, this_week, this_month, this_year):
            self.assertLessEqual(datetime.fromisoformat(meta["played"]), now)

    def test_iso_timestamp_is_exact(self):
        now = datetime(2026, 7, 1, 18, 34, tzinfo=timezone.utc)

        meta = _resolve_played_metadata("2026-07-01T10:05:00Z", now)

        self.assertEqual(meta["played"], "2026-07-01T10:05:00+00:00")
        self.assertEqual(meta["played_precision"], "exact")
        self.assertEqual(meta["played_bucket"], "exact")

    def test_label_transition_uses_distinct_auditable_bucket(self):
        now = datetime(2026, 7, 1, 18, 34, tzinfo=timezone.utc)

        today = _resolve_played_metadata("Today", now)
        this_week = _resolve_played_metadata("This week", now)

        self.assertNotEqual(today["played"], this_week["played"])
        self.assertEqual(this_week["played_precision"], "week")
        self.assertEqual(this_week["played_bucket"], "week:2026-W27")


if __name__ == "__main__":
    unittest.main()
