#!/usr/bin/env python3
"""Consistent, read-only browser history snapshot reader.

Uses SQLite's online backup API instead of copying the main DB without its WAL.
The restrictive temporary snapshot is always removed. stdout is JSON only.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sqlite3
import tempfile
from pathlib import Path
from urllib.parse import quote

CHROMIUM_EPOCH_OFFSET_US = 11_644_473_600_000_000


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser()
    value.add_argument("--browser", choices=("chromium", "firefox"), required=True)
    value.add_argument("--database", required=True)
    value.add_argument("--after-time", type=int, default=-1)
    value.add_argument("--after-id", type=int, default=-1)
    value.add_argument("--limit", type=int, required=True)
    return value


def snapshot_database(path: Path) -> tuple[sqlite3.Connection, str]:
    if not path.is_file():
        raise ValueError("selected browser history database does not exist")
    fd, snapshot_path = tempfile.mkstemp(prefix="total-recall-browser-", suffix=".sqlite")
    os.fchmod(fd, 0o600)
    os.close(fd)
    source = None
    destination = None
    try:
        uri = "file:" + quote(str(path.resolve()).replace("\\", "/"), safe="/:\\") + "?mode=ro"
        source = sqlite3.connect(uri, uri=True, timeout=5)
        destination = sqlite3.connect(snapshot_path)
        source.backup(destination)
        destination.close()
        destination = None
        source.close()
        source = None
        snapshot_uri = "file:" + quote(snapshot_path.replace("\\", "/"), safe="/:\\") + "?mode=ro"
        return sqlite3.connect(snapshot_uri, uri=True), snapshot_path
    except Exception:
        if destination is not None:
            destination.close()
        if source is not None:
            source.close()
        try:
            os.unlink(snapshot_path)
        except FileNotFoundError:
            pass
        raise


def iso_from_unix_us(value: int) -> str:
    try:
        instant = dt.datetime.fromtimestamp(value / 1_000_000, tz=dt.timezone.utc)
    except (OverflowError, OSError, ValueError) as error:
        raise ValueError("browser visit contains an invalid timestamp") from error
    return instant.isoformat(timespec="microseconds").replace("+00:00", "Z")


def read_rows(connection: sqlite3.Connection, browser: str, after_time: int, after_id: int, limit: int) -> list[dict]:
    if browser == "chromium":
        rows = connection.execute(
            """
            SELECT v.id, v.visit_time, u.url, COALESCE(NULLIF(u.title, ''), '')
            FROM visits v JOIN urls u ON u.id = v.url
            WHERE (v.visit_time > ? OR (v.visit_time = ? AND v.id > ?))
            ORDER BY v.visit_time ASC, v.id ASC LIMIT ?
            """,
            (after_time, after_time, after_id, limit),
        )
        return [
            {
                "id": int(row[0]),
                "cursor_time": str(int(row[1])),
                "visited_at": iso_from_unix_us(int(row[1]) - CHROMIUM_EPOCH_OFFSET_US),
                "url": str(row[2]),
                "title": str(row[3]),
            }
            for row in rows
        ]

    rows = connection.execute(
        """
        SELECT v.id, v.visit_date, p.url, COALESCE(NULLIF(p.title, ''), '')
        FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id
        WHERE v.visit_date IS NOT NULL
          AND (v.visit_date > ? OR (v.visit_date = ? AND v.id > ?))
        ORDER BY v.visit_date ASC, v.id ASC LIMIT ?
        """,
        (after_time, after_time, after_id, limit),
    )
    return [
        {
            "id": int(row[0]),
            "cursor_time": str(int(row[1])),
            "visited_at": iso_from_unix_us(int(row[1])),
            "url": str(row[2]),
            "title": str(row[3]),
        }
        for row in rows
    ]


def main() -> int:
    args = parser().parse_args()
    if args.limit < 1 or args.limit > 500:
        raise ValueError("limit must be from 1 to 500")
    connection, snapshot_path = snapshot_database(Path(args.database))
    try:
        rows = read_rows(connection, args.browser, args.after_time, args.after_id, args.limit)
        print(json.dumps({"visits": rows}, separators=(",", ":")))
        return 0
    finally:
        connection.close()
        try:
            os.unlink(snapshot_path)
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # content-free path diagnostics; never print visited URLs
        print(f"browser history read failed: {error}", file=os.sys.stderr)
        raise SystemExit(1)
