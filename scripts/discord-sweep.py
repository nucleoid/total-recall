#!/usr/bin/env python3
"""Checkpointed Discord memory sweep with deterministic crash retries.

State v2 tracks a half-open UTC window per stable Discord channel ID. Extracted
memory text is retained only while a store is pending, in an owner-only state
directory, and is removed as soon as the window checkpoints successfully.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone

SESSIONS_DIR = Path.home() / ".openclaw" / "agents" / "main" / "sessions"
SESSIONS_JSON = SESSIONS_DIR / "sessions.json"
STATE_FILE = Path.home() / ".cache" / "discord-sweep" / "state.json"
LOG_FILE = Path("/tmp/discord-memory-sweep.log")
SKIP_CHANNELS = set()
NAMESPACE_MAP = {}
EXTRACTION_MODEL = "haiku"
MAX_STDERR = 1000

EXTRACTION_PROMPT = """You are a memory extraction agent. Given a Discord conversation excerpt, extract ONLY items worth storing in long-term memory. Return a JSON array of objects.
Each object must have content (a non-empty string), tags (an array of strings), and namespace (a non-empty string).
Return ONLY valid JSON, with no markdown fences or explanation. Return [] when there is nothing worth storing.
Conversation from #{channel}:
{messages}"""


class SweepError(RuntimeError):
    pass


def iso(value):
    return value.astimezone(timezone.utc).isoformat()


def parse_utc(value, field="timestamp"):
    if not isinstance(value, str) or not value:
        raise SweepError(f"invalid {field}")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise SweepError(f"invalid {field}") from exc
    if parsed.tzinfo is None:
        raise SweepError(f"{field} must be offset-aware")
    return parsed.astimezone(timezone.utc)


def load_channel_map():
    with open(SESSIONS_JSON, encoding="utf-8") as handle:
        sessions = json.load(handle)
    channels = {}
    for key, val in sessions.items():
        if "discord:channel:" not in key:
            continue
        display = val.get("displayName", "")
        if "#" not in display:
            continue
        channels[display.split("#", 1)[-1]] = {
            "channel_id": key.split(":")[-1],
            "session_file": val.get("sessionFile", ""),
        }
    return channels


def extract_messages(session_file, start, end):
    """Return messages whose aware timestamps are in [start, end)."""
    if not os.path.exists(session_file):
        return [], 0
    messages, malformed = [], 0
    with open(session_file, encoding="utf-8") as handle:
        for line in handle:
            try:
                entry = json.loads(line)
            except (json.JSONDecodeError, TypeError):
                continue
            if entry.get("type") != "message":
                continue
            msg = entry.get("message", {})
            role = msg.get("role", "")
            if role not in ("user", "assistant"):
                continue
            try:
                ts = parse_utc(entry.get("timestamp"), "message timestamp")
            except SweepError:
                malformed += 1
                continue
            if not start <= ts < end:
                continue
            content = msg.get("content", "")
            if isinstance(content, list):
                text = "\n".join(str(block.get("text", "")) for block in content if isinstance(block, dict) and block.get("type") == "text")
            elif isinstance(content, str):
                text = content
            else:
                continue
            if not text.strip():
                continue
            sender = "user"
            if role == "user":
                for meta_line in text.splitlines():
                    if '"name"' in meta_line and '"sender"' not in meta_line:
                        sender = meta_line.split('"')[-2]
                        break
                parts = text.split("```\n")
                if len(parts) >= 3:
                    remaining = "```\n".join(parts[2:])
                    for marker in ("<<<EXTERNAL_UNTRUSTED_CONTENT", "Untrusted context"):
                        if marker in remaining:
                            remaining = remaining[:remaining.index(marker)].strip()
                    if remaining.strip():
                        text = remaining
            if len(text) > 1500:
                text = text[:1500] + "..."
            messages.append(f"[{ts.strftime('%H:%M UTC')}] {sender if role == 'user' else 'assistant'}: {text}")
    return messages, malformed


def extract_memories_llm(channel, messages_text):
    prompt = EXTRACTION_PROMPT.format(channel=channel, messages=messages_text)
    try:
        result = subprocess.run(["claude", "-p", prompt, "--model", EXTRACTION_MODEL, "--max-turns", "1", "--output-format", "text"], capture_output=True, text=True, timeout=60)
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        raise SweepError(f"LLM call failed: {exc}") from exc
    if result.returncode:
        raise SweepError(f"LLM exited {result.returncode}: {result.stderr[-MAX_STDERR:]}")
    try:
        memories = json.loads(result.stdout.strip())
    except json.JSONDecodeError as exc:
        raise SweepError(f"malformed LLM JSON: {result.stdout[:200]}") from exc
    if not isinstance(memories, list):
        raise SweepError("LLM output must be a JSON array")
    return memories


def normalize_memories(memories, channel):
    normalized = []
    for index, memory in enumerate(memories):
        if not isinstance(memory, dict):
            raise SweepError(f"memory {index} must be an object")
        content = memory.get("content")
        if not isinstance(content, str) or not content.strip():
            raise SweepError(f"memory {index} has invalid content")
        namespace = memory.get("namespace", NAMESPACE_MAP.get(channel, "shared"))
        if not isinstance(namespace, str) or not namespace.strip():
            raise SweepError(f"memory {index} has invalid namespace")
        raw_tags = memory.get("tags", [])
        if not isinstance(raw_tags, list) or any(not isinstance(tag, str) or not tag for tag in raw_tags):
            raise SweepError(f"memory {index} has invalid tags")
        tags = list(raw_tags)
        if channel not in tags:
            tags.append(channel)
        normalized.append({"content": content.strip(), "namespace": namespace, "tags": tags})
    return normalized


def memory_key(channel_id, start, end, index, memory):
    content_hash = hashlib.sha256(json.dumps(memory, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    return f"discord-sweep:v1:{channel_id}:{iso(start)}:{iso(end)}:{index}:{content_hash}"


def store_memory(content, namespace, tags, channel, idempotency_key):
    args = {"content": content, "namespace": namespace, "tags": tags, "source": f"discord-sweep:#{channel}", "idempotency_key": idempotency_key, "agent_name": "discord-sweep", "agent_type": "system", "agent_runtime": "cron"}
    try:
        result = subprocess.run(["mcporter", "call", "total-recall.memory_store", "--args", json.dumps(args)], capture_output=True, text=True, timeout=30)
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        raise SweepError(f"store failed: {exc}") from exc
    if result.returncode:
        raise SweepError(f"mcporter exited {result.returncode}: {result.stderr[-MAX_STDERR:]}")
    try:
        response = json.loads(result.stdout.strip())
        if isinstance(response, dict) and isinstance(response.get("content"), list):
            text_items = [item.get("text") for item in response["content"] if isinstance(item, dict) and item.get("type") == "text"]
            if len(text_items) != 1 or not isinstance(text_items[0], str):
                raise ValueError("unexpected MCP content")
            response = json.loads(text_items[0])
    except (json.JSONDecodeError, ValueError) as exc:
        raise SweepError("store response missing idempotency acknowledgement") from exc
    if not isinstance(response, dict) or response.get("idempotency_key_honored") is not True:
        raise SweepError("store response missing idempotency acknowledgement")
    return True


def _secure_directory(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path, 0o700)


def _fsync_directory(path):
    try:
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError:
        pass


def _atomic_bytes(path, data):
    _secure_directory(path.parent)
    descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        os.chmod(temp_name, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data); handle.flush(); os.fsync(handle.fileno())
        os.replace(temp_name, path)
        os.chmod(path, 0o600)
        _fsync_directory(path.parent)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def load_state():
    if not STATE_FILE.exists():
        return {"version": 2, "channels": {}}, None
    try:
        raw = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SweepError(f"corrupt state file: {exc}") from exc
    if raw.get("version") == 2:
        if not isinstance(raw.get("channels"), dict):
            raise SweepError("corrupt state v2 channels")
        return raw, None
    legacy = parse_utc(raw.get("last_sweep"), "legacy last_sweep") if "last_sweep" in raw else None
    return {"version": 2, "channels": {}}, legacy


def save_state(state):
    _atomic_bytes(STATE_FILE, (json.dumps(state, indent=2, sort_keys=True) + "\n").encode())


def backup_legacy():
    backup = STATE_FILE.with_suffix(STATE_FILE.suffix + ".v1.bak")
    if not backup.exists():
        _atomic_bytes(backup, STATE_FILE.read_bytes())


class StateLock:
    def __init__(self, state_file):
        self.path = state_file.with_suffix(state_file.suffix + ".lock")
        self.handle = None

    def __enter__(self):
        _secure_directory(self.path.parent)
        self.handle = open(self.path, "a+b")
        os.chmod(self.path, 0o600)
        if self.handle.tell() == 0:
            self.handle.write(b"0"); self.handle.flush()
        try:
            if os.name == "nt":
                import msvcrt
                self.handle.seek(0); msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self.handle.close(); self.handle = None
            raise SweepError("another discord sweep owns the state lock") from exc
        return self

    def __exit__(self, *_):
        if self.handle:
            try:
                if os.name == "nt":
                    import msvcrt
                    self.handle.seek(0); msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
            finally:
                self.handle.close()


def log(message):
    line = f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] {message}"
    print(line)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        print(f"warning: could not append {LOG_FILE}", file=sys.stderr)


def _validate_pending(pending, watermark, now):
    if not isinstance(pending, dict) or pending.get("phase") not in ("extract", "store"):
        raise SweepError("corrupt pending state")
    start = parse_utc(pending.get("start"), "pending start")
    end = parse_utc(pending.get("end"), "pending end")
    if start > end or end > now or (watermark and start != watermark):
        raise SweepError("future, backward, or non-adjacent pending window")
    if pending["phase"] == "store":
        memories = pending.get("memories")
        next_index = pending.get("next_index")
        if not isinstance(memories, list) or not isinstance(next_index, int) or not 0 <= next_index <= len(memories):
            raise SweepError("corrupt pending store snapshot")
    return start, end


def _run_real(args, run_started_at):
    channels = load_channel_map()
    if args.channels:
        selected = {name.strip().lstrip("#") for name in args.channels.split(",")}
        channels = {name: info for name, info in channels.items() if name in selected}
    state, legacy = load_state()
    if legacy is not None and channels:
        backup_legacy()
        # Materialize every channel's legacy watermark in one atomic v2 write.
        # A crash during later per-channel work then cannot make untouched
        # channels fall back to a shorter --hours lookback on restart.
        for channel_name, info in channels.items():
            state["channels"][str(info["channel_id"])] = {
                "display_name": channel_name,
                "last_successful_end": iso(legacy),
            }
        save_state(state)
    failures = 0
    for channel_name, info in sorted(channels.items()):
        if channel_name in SKIP_CHANNELS:
            continue
        channel_id = str(info["channel_id"])
        channel = state["channels"].setdefault(channel_id, {"display_name": channel_name})
        channel["display_name"] = channel_name
        try:
            watermark = parse_utc(channel["last_successful_end"], "last_successful_end") if channel.get("last_successful_end") else None
            if watermark and watermark > run_started_at:
                raise SweepError("last_successful_end is in the future")
            pending = channel.get("pending")
            if pending:
                start, end = _validate_pending(pending, watermark, run_started_at)
            else:
                start = watermark or legacy or (run_started_at - timedelta(hours=args.hours))
                end = run_started_at
                if start > end:
                    raise SweepError("window starts after it ends")
                pending = {"start": iso(start), "end": iso(end), "phase": "extract"}
                channel["pending"] = pending
                save_state(state)

            if pending["phase"] == "extract":
                messages, malformed = extract_messages(info["session_file"], start, end)
                if malformed:
                    log(f"#{channel_name}: skipped {malformed} malformed/missing timestamps")
                raw_memories = [] if len(messages) < 3 else extract_memories_llm(channel_name, "\n".join(messages))
                memories = normalize_memories(raw_memories, channel_name)
                pending.update({"phase": "store", "memories": memories, "next_index": 0})
                save_state(state)

            memories = pending["memories"]
            for index in range(pending["next_index"], len(memories)):
                memory = memories[index]
                store_memory(memory["content"], memory["namespace"], list(memory["tags"]), channel_name, idempotency_key=memory_key(channel_id, start, end, index, memory))
                pending["next_index"] = index + 1
                save_state(state)
            channel["last_successful_end"] = iso(end)
            channel.pop("pending", None)
            save_state(state)
        except (SweepError, OSError) as exc:
            failures += 1
            log(f"#{channel_name}: ERROR: {exc}")
    return 1 if failures else 0


def _run_dry(args, run_started_at):
    channels = load_channel_map()
    if args.channels:
        selected = {name.strip().lstrip("#") for name in args.channels.split(",")}
        channels = {name: info for name, info in channels.items() if name in selected}
    state, legacy = load_state()
    for channel_name, info in sorted(channels.items()):
        channel = state.get("channels", {}).get(str(info["channel_id"]), {})
        pending = channel.get("pending")
        watermark = parse_utc(channel["last_successful_end"]) if channel.get("last_successful_end") else None
        if pending:
            _validate_pending(pending, watermark, run_started_at)
        if pending and pending.get("phase") == "store":
            memories = pending["memories"][pending["next_index"]:]
        else:
            start = watermark or legacy or run_started_at - timedelta(hours=args.hours)
            messages, malformed = extract_messages(info["session_file"], start, run_started_at)
            if malformed:
                log(f"#{channel_name}: skipped {malformed} malformed/missing timestamps")
            memories = [] if len(messages) < 3 else normalize_memories(extract_memories_llm(channel_name, "\n".join(messages)), channel_name)
        for memory in memories:
            log(f"#{channel_name}: [DRY RUN] Would store ({memory['namespace']}): {memory['content'][:100]}")
    return 0


def run_sweep(args, run_started_at=None):
    now = (run_started_at or datetime.now(timezone.utc)).astimezone(timezone.utc)
    if args.hours <= 0:
        raise SweepError("--hours must be positive")
    if args.dry_run:
        return _run_dry(args, now)
    with StateLock(STATE_FILE):
        return _run_real(args, now)


def main():
    parser = argparse.ArgumentParser(description="Sweep adjacent Discord channel windows into Total Recall")
    parser.add_argument("--hours", type=int, default=6, help="First-run/new-channel lookback only (default: 6)")
    parser.add_argument("--dry-run", action="store_true", help="Extract only; do not write state or call storage")
    parser.add_argument("--channels", default=None, help="Comma-separated channel names (default: all)")
    try:
        return run_sweep(parser.parse_args())
    except SweepError as exc:
        log(f"ERROR: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
