#!/usr/bin/env python3
"""Sweep recent Discord conversations and store noteworthy items in Total Recall.

Reads recent messages from Discord channel session logs, uses an LLM to extract
decisions, preferences, facts, and lessons, then stores them via the Total Recall
MCP memory_store tool.

Designed to run as a cron job (e.g., every 4-8 hours).

Requirements:
- OpenClaw session logs (JSONL format) with Discord channel mappings
- mcporter CLI with total-recall MCP server configured
- claude CLI (for LLM extraction) — or modify extract_memories_llm() for your setup

Usage:
    discord-sweep.py [--hours 6] [--dry-run] [--channels general,dev]

Example cron (every 6 hours, 1h overlap buffer):
    0 */6 * * * python3 /path/to/discord-sweep.py --hours 7 >> /tmp/discord-sweep.log 2>&1
"""

import json
import subprocess
import sys
import argparse
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path

# === CONFIGURATION ===
# Adjust these paths for your setup

SESSIONS_DIR = Path.home() / ".openclaw" / "agents" / "main" / "sessions"
SESSIONS_JSON = SESSIONS_DIR / "sessions.json"
STATE_FILE = Path.home() / ".cache" / "discord-sweep-state.json"
LOG_FILE = Path("/tmp/discord-memory-sweep.log")

# Channels to skip (e.g., noisy alert channels)
SKIP_CHANNELS = set()

# Map channel names to Total Recall namespaces.
# Channels not listed here default to "shared".
NAMESPACE_MAP = {
    # "work-general": "work",
    # "project-dev": "projects",
    # "finance-chat": "financial",
}

# LLM model for extraction (claude CLI model name)
EXTRACTION_MODEL = "haiku"

# === END CONFIGURATION ===

EXTRACTION_PROMPT = """You are a memory extraction agent. Given a Discord conversation excerpt, extract ONLY items worth storing in long-term memory. Return a JSON array of objects.

Each object must have:
- "content": A concise, self-contained summary (1-3 sentences). Include enough context that it makes sense without the conversation.
- "tags": Array of relevant tags (project names, people, topics)
- "namespace": One of: personal, work, projects, financial, shared

Rules:
- Only extract decisions, preferences, facts, plans, lessons, or action items
- Skip greetings, banter, acknowledgements, status updates with no new info
- Skip anything that's just an AI assistant talking to itself or repeating instructions
- Each item must stand alone — future readers won't have the conversation
- If there's nothing worth storing, return an empty array: []
- Return ONLY valid JSON, no markdown fences, no explanation

Conversation from #{channel}:
{messages}"""


def load_channel_map():
    """Build channel_name -> {channel_id, session_file} from OpenClaw sessions."""
    with open(SESSIONS_JSON) as f:
        sessions = json.load(f)
    channels = {}
    for key, val in sessions.items():
        if "discord:channel:" not in key:
            continue
        display = val.get("displayName", "")
        if "#" not in display:
            continue
        channel_id = key.split(":")[-1]
        channel_name = display.split("#", 1)[-1]
        session_file = val.get("sessionFile", "")
        channels[channel_name] = {
            "channel_id": channel_id,
            "session_file": session_file,
        }
    return channels


def extract_messages(session_file, hours=6):
    """Extract recent user/assistant messages from a JSONL session log."""
    if not os.path.exists(session_file):
        return []

    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    messages = []

    with open(session_file) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            if entry.get("type") != "message":
                continue

            msg = entry.get("message", {})
            role = msg.get("role", "")
            if role not in ("user", "assistant"):
                continue

            timestamp_str = entry.get("timestamp", "")
            ts = None
            if timestamp_str:
                try:
                    ts = datetime.fromisoformat(timestamp_str.replace("Z", "+00:00"))
                except ValueError:
                    pass

            if ts and ts < cutoff:
                continue

            content = msg.get("content", "")
            if isinstance(content, list):
                text_parts = []
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        text_parts.append(block["text"])
                text = "\n".join(text_parts)
            elif isinstance(content, str):
                text = content
            else:
                continue

            if not text.strip():
                continue

            # Extract sender name from user messages (OpenClaw metadata format)
            sender = "user"
            if role == "user":
                for meta_line in text.split("\n"):
                    if '"name"' in meta_line and '"sender"' not in meta_line:
                        try:
                            sender = meta_line.split('"')[-2]
                        except Exception:
                            pass
                        break

            # Strip metadata wrappers from user messages
            actual_text = text
            if role == "user":
                parts = text.split("```\n")
                if len(parts) >= 3:
                    remaining = "```\n".join(parts[2:])
                    for marker in ("<<<EXTERNAL_UNTRUSTED_CONTENT", "Untrusted context"):
                        if marker in remaining:
                            remaining = remaining[:remaining.index(marker)].strip()
                    actual_text = remaining if remaining.strip() else text

            if len(actual_text) > 1500:
                actual_text = actual_text[:1500] + "..."

            label = sender if role == "user" else "assistant"
            ts_display = ts.strftime("%H:%M UTC") if ts else "?"
            messages.append(f"[{ts_display}] {label}: {actual_text}")

    return messages


def extract_memories_llm(channel, messages_text):
    """Use an LLM to extract storable memories from a conversation excerpt."""
    prompt = EXTRACTION_PROMPT.format(channel=channel, messages=messages_text)

    try:
        result = subprocess.run(
            [
                "claude", "-p", prompt,
                "--model", EXTRACTION_MODEL,
                "--max-turns", "1",
                "--output-format", "text",
            ],
            capture_output=True, text=True, timeout=60,
        )
        response = result.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        log(f"  LLM call failed: {e}")
        return []

    try:
        if "```" in response:
            response = response.split("```")[1]
            if response.startswith("json"):
                response = response[4:]
        memories = json.loads(response.strip())
        if not isinstance(memories, list):
            return []
        return memories
    except json.JSONDecodeError:
        log(f"  Failed to parse LLM response: {response[:200]}")
        return []


def store_memory(content, namespace, tags, channel):
    """Store a memory via mcporter -> total-recall MCP."""
    args = {
        "content": content,
        "namespace": namespace,
        "tags": tags,
        "source": f"discord-sweep:#{channel}",
    }
    try:
        result = subprocess.run(
            ["mcporter", "call", "total-recall.memory_store", "--args", json.dumps(args)],
            capture_output=True, text=True, timeout=30,
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        log(f"  Store failed: {e}")
        return False


def load_state():
    if STATE_FILE.exists():
        with open(STATE_FILE) as f:
            return json.load(f)
    return {}


def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def log(msg):
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    line = f"[{timestamp}] {msg}"
    print(line)
    with open(LOG_FILE, "a") as f:
        f.write(line + "\n")


def main():
    parser = argparse.ArgumentParser(description="Sweep Discord channels for memories to store in Total Recall")
    parser.add_argument("--hours", type=int, default=6, help="Look back N hours (default: 6)")
    parser.add_argument("--dry-run", action="store_true", help="Extract but don't store")
    parser.add_argument("--channels", type=str, default=None, help="Comma-separated channel list (default: all)")
    args = parser.parse_args()

    channels = load_channel_map()
    state = load_state()

    if args.channels:
        filter_set = set(c.strip().lstrip("#") for c in args.channels.split(","))
        channels = {k: v for k, v in channels.items() if k in filter_set}

    total_stored = 0
    total_extracted = 0

    log(f"=== Discord Memory Sweep (last {args.hours}h) ===")

    for channel_name, info in sorted(channels.items()):
        if channel_name in SKIP_CHANNELS:
            continue

        messages = extract_messages(info["session_file"], hours=args.hours)
        if len(messages) < 3:
            continue

        log(f"#{channel_name}: {len(messages)} messages")
        messages_text = "\n".join(messages)

        memories = extract_memories_llm(channel_name, messages_text)
        if not memories:
            log(f"  Nothing worth storing")
            continue

        total_extracted += len(memories)
        log(f"  Extracted {len(memories)} memories")

        for mem in memories:
            content = mem.get("content", "")
            if not content:
                continue

            namespace = mem.get("namespace", NAMESPACE_MAP.get(channel_name, "shared"))
            tags = mem.get("tags", [channel_name])
            if channel_name not in tags:
                tags.append(channel_name)

            if args.dry_run:
                log(f"  [DRY RUN] Would store ({namespace}): {content[:100]}")
            else:
                if store_memory(content, namespace, tags, channel_name):
                    total_stored += 1
                    log(f"  Stored ({namespace}): {content[:80]}")
                else:
                    log(f"  FAILED to store: {content[:80]}")

    state["last_sweep"] = datetime.now(timezone.utc).isoformat()
    state["last_hours"] = args.hours
    state["last_stored"] = total_stored
    state["last_extracted"] = total_extracted
    save_state(state)

    log(f"=== Done: {total_extracted} extracted, {total_stored} stored ===")


if __name__ == "__main__":
    main()
