#!/usr/bin/env python3
"""Bridge between the Node connector and ytmusicapi.

Modes:
  auth   - run the device-code OAuth flow and emit token JSON on stdout.
  fetch  - use a stored token to fetch get_history() and emit JSON on stdout.

All success output is JSON on stdout. Errors are JSON on stderr with a
non-zero exit code so the Node side can keep stdout clean for parsing.
"""

import argparse
import contextlib
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timedelta, timezone


_RELATIVE_TIME_RE = re.compile(
    r"^\s*(?P<n>\d+)\s+(?P<unit>minute|hour|day|week|month|year)s?\s+ago\s*$",
    re.IGNORECASE,
)


def _utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _metadata(
    played: datetime,
    precision: str,
    bucket: str,
    start: datetime | None = None,
    end: datetime | None = None,
):
    payload = {
        "played": _utc(played).isoformat(),
        "played_precision": precision,
        "played_bucket": bucket,
    }
    if start is not None:
        payload["played_bucket_start"] = _utc(start).isoformat()
    if end is not None:
        payload["played_bucket_end"] = _utc(end).isoformat()
    return payload


def _day_bucket(day):
    start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    end = start + timedelta(days=1)
    return _metadata(start, "day", f"day:{day.isoformat()}", start, end)


def _week_bucket(day):
    start_day = day - timedelta(days=day.weekday())
    start = datetime(start_day.year, start_day.month, start_day.day, tzinfo=timezone.utc)
    end = start + timedelta(days=7)
    year, week, _weekday = start_day.isocalendar()
    return _metadata(start, "week", f"week:{year}-W{week:02d}", start, end)


def _add_months(year: int, month: int, delta: int) -> tuple[int, int]:
    index = year * 12 + (month - 1) + delta
    return index // 12, index % 12 + 1


def _month_bucket(year: int, month: int):
    start = datetime(year, month, 1, tzinfo=timezone.utc)
    end_year, end_month = _add_months(year, month, 1)
    end = datetime(end_year, end_month, 1, tzinfo=timezone.utc)
    return _metadata(start, "month", f"month:{year:04d}-{month:02d}", start, end)


def _year_bucket(year: int):
    start = datetime(year, 1, 1, tzinfo=timezone.utc)
    end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    return _metadata(start, "year", f"year:{year:04d}", start, end)


def _hour_bucket(dt: datetime):
    start = _utc(dt).replace(minute=0, second=0, microsecond=0)
    end = start + timedelta(hours=1)
    return _metadata(start, "hour", f"hour:{start.strftime('%Y-%m-%dT%H')}", start, end)


def _minute_bucket(dt: datetime):
    start = _utc(dt).replace(second=0, microsecond=0)
    end = start + timedelta(minutes=1)
    return _metadata(start, "minute", f"minute:{start.strftime('%Y-%m-%dT%H:%M')}", start, end)


def _resolve_played_metadata(raw: str | None, now: datetime) -> dict | None:
    """Convert a YT Music played label to representative timestamp metadata."""
    if not raw:
        return None
    s = raw.strip().lower()
    now = _utc(now)
    today = now.date()

    if s in ("today", "just now"):
        return _day_bucket(today)
    if s in ("yesterday",):
        return _day_bucket(today - timedelta(days=1))
    if s in ("this week",):
        return _week_bucket(today)
    if s in ("last week", "a week ago"):
        return _week_bucket(today - timedelta(weeks=1))
    if s in ("this month",):
        return _month_bucket(now.year, now.month)
    if s in ("last month", "a month ago"):
        year, month = _add_months(now.year, now.month, -1)
        return _month_bucket(year, month)
    if s in ("this year",):
        return _year_bucket(now.year)
    if s in ("last year", "a year ago"):
        return _year_bucket(now.year - 1)

    m = _RELATIVE_TIME_RE.match(s)
    if m:
        n = int(m.group("n"))
        unit = m.group("unit").lower()
        if unit == "minute":
            return _minute_bucket(now - timedelta(minutes=n))
        if unit == "hour":
            return _hour_bucket(now - timedelta(hours=n))
        if unit == "day":
            return _day_bucket(today - timedelta(days=n))
        if unit == "week":
            return _week_bucket(today - timedelta(weeks=n))
        if unit == "month":
            year, month = _add_months(now.year, now.month, -n)
            return _month_bucket(year, month)
        if unit == "year":
            return _year_bucket(now.year - n)

    try:
        played = _utc(datetime.fromisoformat(s.replace("z", "+00:00")))
        return _metadata(played, "exact", "exact", played, played)
    except ValueError:
        return None


def _resolve_played_at(raw: str | None, now: datetime) -> str | None:
    metadata = _resolve_played_metadata(raw, now)
    return metadata["played"] if metadata else None


_CURL_H_RE = re.compile(r"-H\s+(['\"])(.*?)\1", re.DOTALL)
_CURL_COOKIE_RE = re.compile(r"(?:-b|--cookie)\s+(['\"])(.*?)\1", re.DOTALL)


def _curl_to_raw_headers(text: str) -> str:
    """Convert a "Copy as cURL" command into raw "Name: value" headers."""
    h_matches = _CURL_H_RE.findall(text)
    b_matches = _CURL_COOKIE_RE.findall(text)
    if not h_matches and not b_matches:
        return text

    lines = [value for _quote, value in h_matches]
    has_cookie_header = any(line.lower().startswith("cookie:") for line in lines)
    if b_matches and not has_cookie_header:
        cookies = "; ".join(v for _q, v in b_matches if v.strip())
        if cookies:
            lines.append(f"cookie: {cookies}")
    return "\n".join(lines) + "\n"


def _looks_like_curl(text: str) -> bool:
    stripped = text.lstrip()
    return stripped.startswith("curl ") or stripped.startswith("curl.exe ") or " -H " in stripped[:200]


def _eprint(payload):
    sys.stderr.write(json.dumps(payload) + "\n")


def cmd_auth(args):
    try:
        import ytmusicapi
    except ImportError:
        _eprint({"error": "ytmusicapi not installed. Run: pip install ytmusicapi"})
        sys.exit(2)

    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        temp_path = f.name

    try:
        with contextlib.redirect_stdout(sys.stderr):
            ytmusicapi.setup_oauth(
                client_id=args.client_id,
                client_secret=args.client_secret,
                filepath=temp_path,
                open_browser=False,
            )
        with open(temp_path) as f:
            token = json.load(f)
        token["_client_id"] = args.client_id
        token["_client_secret"] = args.client_secret
        token["_auth_type"] = "oauth"
        sys.stdout.write(json.dumps(token))
    finally:
        try:
            os.unlink(temp_path)
        except OSError:
            pass


def cmd_auth_browser(args):
    """Read raw browser request headers from stdin and produce a config blob."""
    try:
        import ytmusicapi
    except ImportError:
        _eprint({"error": "ytmusicapi not installed. Run: pip install ytmusicapi"})
        sys.exit(2)

    headers_raw = sys.stdin.read()
    if not headers_raw.strip():
        _eprint({"error": "no headers supplied on stdin"})
        sys.exit(2)

    if _looks_like_curl(headers_raw):
        headers_raw = _curl_to_raw_headers(headers_raw)
        if not headers_raw.strip():
            _eprint({"error": "input looked like a cURL command but no -H headers were found"})
            sys.exit(2)

    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        temp_path = f.name

    try:
        with contextlib.redirect_stdout(sys.stderr):
            ytmusicapi.setup(filepath=temp_path, headers_raw=headers_raw)
        with open(temp_path) as f:
            config = json.load(f)
        config["_auth_type"] = "browser"
        sys.stdout.write(json.dumps(config))
    finally:
        try:
            os.unlink(temp_path)
        except OSError:
            pass


def cmd_fetch(args):
    try:
        from ytmusicapi import OAuthCredentials, YTMusic
    except ImportError:
        _eprint({"error": "ytmusicapi not installed. Run: pip install ytmusicapi"})
        sys.exit(2)

    with open(args.token_file) as f:
        token = json.load(f)

    auth_type = token.pop("_auth_type", None) or "oauth"

    if auth_type == "browser":
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(token, f)
            clean_token_path = f.name
        creds = None
    else:
        client_id = token.pop("_client_id", None) or args.client_id
        client_secret = token.pop("_client_secret", None) or args.client_secret
        if not client_id or not client_secret:
            _eprint({"error": "client_id/client_secret not stored in token and not provided"})
            sys.exit(2)
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(token, f)
            clean_token_path = f.name
        creds = OAuthCredentials(client_id=client_id, client_secret=client_secret)

    try:
        yt = YTMusic(clean_token_path, oauth_credentials=creds) if creds else YTMusic(clean_token_path)
        items = yt.get_history() or []

        since_ts = None
        if args.since:
            try:
                since_ts = _utc(datetime.fromisoformat(args.since.replace("Z", "+00:00")))
            except ValueError:
                pass

        now = datetime.now(timezone.utc)
        filtered = []
        for item in items:
            played_raw = item.get("played")
            played_meta = _resolve_played_metadata(played_raw, now)
            if played_meta:
                item["played_raw"] = played_raw
                item.update(played_meta)
            else:
                _eprint({
                    "skipped": {
                        "reason": "unparsable played bucket",
                        "played": played_raw,
                        "videoId": item.get("videoId"),
                    }
                })
                continue

            if since_ts and item.get("played_precision") == "exact":
                played_ts = _utc(datetime.fromisoformat(item["played"]))
                if played_ts <= since_ts:
                    continue

            filtered.append(item)

        if auth_type == "oauth":
            try:
                with open(clean_token_path) as f:
                    refreshed = json.load(f)
                if refreshed != token:
                    refreshed["_client_id"] = client_id
                    refreshed["_client_secret"] = client_secret
                    refreshed["_auth_type"] = "oauth"
                    _eprint({"token_update": refreshed})
            except (IOError, json.JSONDecodeError):
                pass

        sys.stdout.write(json.dumps({
            "items": filtered,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }))
    finally:
        try:
            os.unlink(clean_token_path)
        except OSError:
            pass


def main():
    parser = argparse.ArgumentParser(description="ytmusicapi bridge for total-recall")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_auth = sub.add_parser("auth", help="Run device-code OAuth and emit token JSON")
    p_auth.add_argument("--client-id", required=True)
    p_auth.add_argument("--client-secret", required=True)

    sub.add_parser("auth-browser", help="Read browser request headers from stdin and emit config JSON")

    p_fetch = sub.add_parser("fetch", help="Fetch get_history() using a stored token")
    p_fetch.add_argument("--token-file", required=True)
    p_fetch.add_argument("--since", default=None, help="ISO timestamp; exact rows only")
    p_fetch.add_argument("--client-id", default=None)
    p_fetch.add_argument("--client-secret", default=None)

    args = parser.parse_args()

    try:
        if args.cmd == "auth":
            cmd_auth(args)
        elif args.cmd == "auth-browser":
            cmd_auth_browser(args)
        elif args.cmd == "fetch":
            cmd_fetch(args)
    except Exception as exc:
        _eprint({"error": str(exc)})
        sys.exit(1)


if __name__ == "__main__":
    main()
