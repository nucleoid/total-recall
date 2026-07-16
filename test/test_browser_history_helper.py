import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts" / "browser_history_helper.py"
CHROME_OFFSET = 11_644_473_600_000_000


class BrowserHistoryHelperTests(unittest.TestCase):
    def run_helper(self, browser: str, database: Path):
        result = subprocess.run(
            [sys.executable, str(HELPER), "--browser", browser, "--database", str(database),
             "--after-time", "-1", "--after-id", "-1", "--limit", "10"],
            check=True, capture_output=True, text=True,
        )
        return json.loads(result.stdout)["visits"]

    def test_chromium_epoch_and_committed_wal_are_read_consistently(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "History"
            connection = sqlite3.connect(path)
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA wal_autocheckpoint=0")
            connection.executescript("CREATE TABLE urls(id INTEGER PRIMARY KEY,url TEXT,title TEXT); CREATE TABLE visits(id INTEGER PRIMARY KEY,url INTEGER,visit_time INTEGER);")
            connection.execute("INSERT INTO urls VALUES(1,'https://example.com/path?q=secret','Example')")
            connection.execute("INSERT INTO visits VALUES(7,1,?)", (CHROME_OFFSET + 1_700_000_000_000_000,))
            connection.commit()
            try:
                visits = self.run_helper("chromium", path)
            finally:
                connection.close()
            self.assertEqual(visits[0]["id"], 7)
            self.assertEqual(visits[0]["cursor_time"], str(CHROME_OFFSET + 1_700_000_000_000_000))
            self.assertEqual(visits[0]["visited_at"], "2023-11-14T22:13:20.000000Z")

    def test_firefox_visit_epoch_uses_unix_microseconds(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "places.sqlite"
            connection = sqlite3.connect(path)
            connection.executescript("CREATE TABLE moz_places(id INTEGER PRIMARY KEY,url TEXT,title TEXT); CREATE TABLE moz_historyvisits(id INTEGER PRIMARY KEY,place_id INTEGER,visit_date INTEGER);")
            connection.execute("INSERT INTO moz_places VALUES(1,'https://example.org/','Example')")
            connection.execute("INSERT INTO moz_historyvisits VALUES(9,1,1700000001000000)")
            connection.commit()
            connection.close()
            visits = self.run_helper("firefox", path)
            self.assertEqual(visits[0]["id"], 9)
            self.assertEqual(visits[0]["cursor_time"], "1700000001000000")
            self.assertEqual(visits[0]["visited_at"], "2023-11-14T22:13:21.000000Z")


if __name__ == "__main__":
    unittest.main()
