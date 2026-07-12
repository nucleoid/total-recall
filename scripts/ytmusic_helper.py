#!/usr/bin/env python3
"""Bridge between the Node connector and ytmusicapi (Python only).

Modes:
  auth   — run the device-code OAuth flow and emit the resulting token JSON
           on stdout. The Node side persists it to connector_credentials.
  fetch  — using a previously obtained token, fetch get_history() and emit
           the filtered list as JSON on stdout.

All output is plain JSON on stdout (success) or a JSON error on stderr with
exit code != 0. Keeps stdout clean for the Node parser.

Usage:
  ytmusic_helper.py auth --client-id ID --client-secret SECRET
  ytmusic_helper.py fetch --token-file PATH [--since ISO_TIMESTAMP]

Requires:  pip install ytmusicapi
"""

import argparse
import contextlib
import json
import os
import re
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone


_RELATIVE_TIME_RE = re.compile(
    r"^\s*(?P<n>\d+)\s+(?P<unit>minute|hour|day|week|month|year)s?\s+ago\s*$",
    re.IGNORECASE,
)
_YEAR_RE = re.compile(r"^\d{4}$")
_MONTHS = {
    "january": 1,
    "jan": 1,
    "february": 2,
    "feb": 2,
    "march": 3,
    "mar": 3,
    "april": 4,
    "apr": 4,
    "may": 5,
    "june": 6,
    "jun": 6,
    "july": 7,
    "jul": 7,
    "august": 8,
    "aug": 8,
    "september": 9,
    "sep": 9,
    "october": 10,
    "oct": 10,
    "november": 11,
    "nov": 11,
    "december": 12,
    "dec": 12,
}


@dataclass(frozen=True)
class PlayedAtResolution:
    iso: str
    precision: str
    bucket: str | None = None
    since_comparable: bool = False


def _require_utc_now(now: datetime) -> datetime:
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    return now.astimezone(timezone.utc)


def _iso_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _parse_absolute(raw: str) -> PlayedAtResolution | None:
    s = raw.strip()
    if s.endswith(("Z", "z")):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None or dt.utcoffset() is None:
        return None
    return PlayedAtResolution(_iso_utc(dt), "instant", since_comparable=True)


def _week_midpoint(now: datetime) -> datetime:
    monday = (now - timedelta(days=now.weekday())).date()
    return datetime(monday.year, monday.month, monday.day, 12, tzinfo=timezone.utc) + timedelta(days=2)


def _day_midpoint(dt: datetime) -> datetime:
    target = dt.date()
    return datetime(target.year, target.month, target.day, 12, tzinfo=timezone.utc)


def _month_midpoint(year: int, month: int) -> datetime:
    return datetime(year, month, 15, 12, tzinfo=timezone.utc)


def _year_midpoint(year: int) -> datetime:
    return datetime(year, 7, 2, 12, tzinfo=timezone.utc)


def _subtract_months(dt: datetime, months: int) -> tuple[int, int]:
    month_index = (dt.year * 12 + (dt.month - 1)) - months
    return month_index // 12, (month_index % 12) + 1


def _subtract_years(dt: datetime, years: int) -> int:
    return dt.year - years


def _resolve_played_at_details(raw: str | None, now: datetime) -> PlayedAtResolution | None:
    if not raw:
        return None

    absolute = _parse_absolute(raw)
    if absolute:
        return absolute

    now = _require_utc_now(now)
    s = raw.strip().lower()

    if s == "this week":
        return PlayedAtResolution(_week_midpoint(now).isoformat(), "week", s)
    if s == "this month":
        return PlayedAtResolution(_month_midpoint(now.year, now.month).isoformat(), "month", s)
    if s in _MONTHS:
        month = _MONTHS[s]
        year = now.year if month <= now.month else now.year - 1
        return PlayedAtResolution(_month_midpoint(year, month).isoformat(), "month", s)
    if _YEAR_RE.match(s):
        year = int(s)
        if year == 0:
            return None
        try:
            return PlayedAtResolution(_year_midpoint(year).isoformat(), "year", s)
        except ValueError:
            return None

    if s in ("today", "just now"):
        return PlayedAtResolution(_day_midpoint(now).isoformat(), "day", s)
    if s in ("yesterday",):
        return PlayedAtResolution(_day_midpoint(now - timedelta(days=1)).isoformat(), "day", s)
    if s in ("last week", "a week ago"):
        return PlayedAtResolution(_week_midpoint(now - timedelta(weeks=1)).isoformat(), "week", s)
    if s in ("last month", "a month ago"):
        year, month = _subtract_months(now, 1)
        return PlayedAtResolution(_month_midpoint(year, month).isoformat(), "month", s)
    if s in ("last year", "a year ago"):
        return PlayedAtResolution(_year_midpoint(_subtract_years(now, 1)).isoformat(), "year", s)

    m = _RELATIVE_TIME_RE.match(s)
    if m:
        n = int(m.group("n"))
        unit = m.group("unit").lower()
        delta = {
            "minute": timedelta(minutes=n),
            "hour": timedelta(hours=n),
            "day": timedelta(days=n),
            "week": timedelta(weeks=n),
        }.get(unit)
        if unit == "month":
            year, month = _subtract_months(now, n)
            if year < 1:
                return None
            ts = _month_midpoint(year, month)
        elif unit == "year":
            year = _subtract_years(now, n)
            if year < 1:
                return None
            ts = _year_midpoint(year)
        else:
            ts = now - delta
            if unit == "minute":
                ts = ts.replace(second=0, microsecond=0)
            elif unit == "hour":
                ts = ts.replace(minute=0, second=0, microsecond=0)
            elif unit == "day":
                ts = _day_midpoint(ts)
            elif unit == "week":
                ts = _week_midpoint(ts)
        return PlayedAtResolution(ts.isoformat(), unit, s, unit in ("minute", "hour"))

    return None


def _resolve_played_at(raw: str | None, now: datetime) -> str | None:
    """Convert YouTube Music's fuzzy "played" string to an ISO timestamp.

    YouTube returns relative buckets ("Today", "Yesterday", "Last week",
    "5 hours ago", etc) instead of exact timestamps. We map each bucket to
    a representative datetime so the same bucket on consecutive syncs lands
    on the same row. Precision is the bucket itself — we don't claim more.
    """
    resolved = _resolve_played_at_details(raw, now)
    return resolved.iso if resolved else None


_CURL_H_RE = re.compile(r"-H\s+(['\"])(.*?)\1", re.DOTALL)
# Chrome's "Copy as cURL" puts cookies in `-b 'key=v; key=v'` rather than a
# `cookie:` header. Cover both -b and --cookie.
_CURL_COOKIE_RE = re.compile(r"(?:-b|--cookie)\s+(['\"])(.*?)\1", re.DOTALL)


def _curl_to_raw_headers(text: str) -> str:
    """Convert a "Copy as cURL" command into raw "Name: value" header lines.

    Chrome/Firefox both emit headers as `-H 'Name: value'` (single quotes on
    *nix flavour) or `-H "Name: value"` (Windows cmd flavour). They put
    session cookies in `-b 'k=v; k=v'` rather than a `cookie:` header — we
    promote those to a synthesised `cookie: ...` line.
    """
    h_matches = _CURL_H_RE.findall(text)
    b_matches = _CURL_COOKIE_RE.findall(text)
    if not h_matches and not b_matches:
        return text

    lines = [value for _quote, value in h_matches]
    # Only synthesise a cookie header if one wasn't already supplied via -H.
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
        # setup_oauth prints "Go to https://... and enter code XXX-XXX-XXX"
        # then blocks until the user completes. open_browser=False keeps it
        # purely terminal-driven (works on headless boxes).
        # We redirect stdout to stderr so the verification URL is visible to
        # the user via the Node parent (which inherits stderr), and the final
        # JSON token alone goes to stdout for parsing.
        with contextlib.redirect_stdout(sys.stderr):
            ytmusicapi.setup_oauth(
                client_id=args.client_id,
                client_secret=args.client_secret,
                filepath=temp_path,
                open_browser=False,
            )
        with open(temp_path) as f:
            token = json.load(f)
        # Include the client creds in the persisted blob so fetch can
        # reconstruct without them being passed on every call.
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
    """Read raw browser request headers from stdin and produce a config blob.

    ytmusicapi.setup() expects a 'headers_raw' string of the form copied
    from DevTools (one 'Name: value' per line). It returns the JSON config
    needed for subsequent YTMusic() calls.
    """
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
        from ytmusicapi import YTMusic, OAuthCredentials
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
                since_ts = datetime.fromisoformat(args.since.replace("Z", "+00:00"))
            except ValueError:
                pass

        now = datetime.now(timezone.utc)
        filtered = []
        for item in items:
            played_raw = item.get("played")
            played = _resolve_played_at_details(played_raw, now)
            if played:
                # Replace the human-readable bucket with the ISO timestamp
                # so the Node transform can pass it straight through.
                item["played_raw"] = played_raw
                item["played"] = played.iso
                item["played_precision"] = played.precision
                item["played_cursor_eligible"] = played.since_comparable
                if played.bucket is not None:
                    item["played_bucket"] = played.bucket
            else:
                # Couldn't parse — drop so we don't poison the DB with a
                # malformed timestamptz. Logged for visibility.
                _eprint({"skipped": {"reason": "unparsable played bucket", "played": played_raw, "videoId": item.get("videoId")}})
                continue

            if since_ts and played.since_comparable:
                try:
                    played_ts = datetime.fromisoformat(played.iso)
                except ValueError:
                    played_ts = None
                if played_ts and played_ts <= since_ts:
                    continue

            filtered.append(item)

        # If the token was refreshed during the call, re-emit it via stderr
        # in a structured "TOKEN_UPDATE" line so the Node side can persist.
        # Only OAuth tokens refresh; browser headers stay static.
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
    p_fetch.add_argument("--since", default=None, help="ISO timestamp; only return items played after")
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
