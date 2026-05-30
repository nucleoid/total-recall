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
import sys
import tempfile
from datetime import datetime, timezone


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
        sys.stdout.write(json.dumps(token))
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

    client_id = token.pop("_client_id", None) or args.client_id
    client_secret = token.pop("_client_secret", None) or args.client_secret
    if not client_id or not client_secret:
        _eprint({"error": "client_id/client_secret not stored in token and not provided"})
        sys.exit(2)

    # ytmusicapi expects a token file path, not a dict. Write a clean copy.
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(token, f)
        clean_token_path = f.name

    try:
        creds = OAuthCredentials(client_id=client_id, client_secret=client_secret)
        yt = YTMusic(clean_token_path, oauth_credentials=creds)

        items = yt.get_history() or []

        since_ts = None
        if args.since:
            try:
                since_ts = datetime.fromisoformat(args.since.replace("Z", "+00:00"))
            except ValueError:
                pass

        filtered = []
        for item in items:
            played_raw = item.get("played")
            played_ts = None
            if played_raw:
                try:
                    # YouTube returns ISO 8601 timestamps
                    played_ts = datetime.fromisoformat(played_raw.replace("Z", "+00:00"))
                except ValueError:
                    pass
            if since_ts and played_ts and played_ts <= since_ts:
                continue
            filtered.append(item)

        # If the token was refreshed during the call, re-emit it via stderr
        # in a structured "TOKEN_UPDATE" line so the Node side can persist.
        try:
            with open(clean_token_path) as f:
                refreshed = json.load(f)
            if refreshed != token:
                refreshed["_client_id"] = client_id
                refreshed["_client_secret"] = client_secret
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

    p_fetch = sub.add_parser("fetch", help="Fetch get_history() using a stored token")
    p_fetch.add_argument("--token-file", required=True)
    p_fetch.add_argument("--since", default=None, help="ISO timestamp; only return items played after")
    p_fetch.add_argument("--client-id", default=None)
    p_fetch.add_argument("--client-secret", default=None)

    args = parser.parse_args()

    try:
        if args.cmd == "auth":
            cmd_auth(args)
        elif args.cmd == "fetch":
            cmd_fetch(args)
    except Exception as exc:
        _eprint({"error": str(exc)})
        sys.exit(1)


if __name__ == "__main__":
    main()
