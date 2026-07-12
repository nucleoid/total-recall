import argparse
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock
from datetime import datetime, timedelta, timezone

SCRIPT = Path(__file__).parents[1] / "scripts" / "discord-sweep.py"
spec = importlib.util.spec_from_file_location("discord_sweep", SCRIPT)
sweep = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sweep)
UTC = timezone.utc


def args(hours=6, dry_run=False):
    return argparse.Namespace(hours=hours, dry_run=dry_run, channels=None)


class DiscordSweepTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / "private" / "state.json"
        self.log = Path(self.tmp.name) / "sweep.log"
        self.patchers = [
            mock.patch.object(sweep, "STATE_FILE", self.state),
            mock.patch.object(sweep, "LOG_FILE", self.log),
            mock.patch.object(sweep, "load_channel_map", return_value={"general": {"channel_id": "42", "session_file": "unused"}}),
        ]
        for patcher in self.patchers:
            patcher.start(); self.addCleanup(patcher.stop)

    def test_half_open_boundaries_and_timeless_records(self):
        start = datetime(2026, 1, 1, tzinfo=UTC)
        end = start + timedelta(hours=6)
        records = [
            {"type": "message", "timestamp": start.isoformat(), "message": {"role": "user", "content": "at start"}},
            {"type": "message", "timestamp": end.isoformat(), "message": {"role": "user", "content": "at end"}},
            {"type": "message", "message": {"role": "user", "content": "timeless"}},
            {"type": "message", "timestamp": "broken", "message": {"role": "user", "content": "bad"}},
        ]
        session = Path(self.tmp.name) / "session.jsonl"
        session.write_text("\n".join(json.dumps(r) for r in records), encoding="utf-8")
        messages, malformed = sweep.extract_messages(session, start, end)
        self.assertEqual(len(messages), 1)
        self.assertIn("at start", messages[0])
        self.assertEqual(malformed, 2)

    def test_adjacent_windows_and_initial_hours_only(self):
        seen = []
        def extract(_file, start, end):
            seen.append((start, end)); return [], 0
        with mock.patch.object(sweep, "extract_messages", side_effect=extract):
            self.assertEqual(sweep.run_sweep(args(), datetime(2026, 1, 1, 6, tzinfo=UTC)), 0)
            self.assertEqual(sweep.run_sweep(args(hours=99), datetime(2026, 1, 1, 12, tzinfo=UTC)), 0)
        self.assertEqual(seen[0], (datetime(2026, 1, 1, 0, tzinfo=UTC), datetime(2026, 1, 1, 6, tzinfo=UTC)))
        self.assertEqual(seen[1], (seen[0][1], datetime(2026, 1, 1, 12, tzinfo=UTC)))

    def test_store_phase_reuses_snapshot_and_converges(self):
        memory = {"content": "remember this", "namespace": "shared", "tags": ["decision"]}
        stores = []
        def fail_store(*_args, **kwargs):
            stores.append(kwargs)
            raise sweep.SweepError("store failed")
        with mock.patch.object(sweep, "extract_messages", return_value=(["a", "b", "c"], 0)), \
             mock.patch.object(sweep, "extract_memories_llm", return_value=[memory]), \
             mock.patch.object(sweep, "store_memory", side_effect=fail_store):
            self.assertEqual(sweep.run_sweep(args(), datetime(2026, 1, 1, 6, tzinfo=UTC)), 1)
        pending = json.loads(self.state.read_text())["channels"]["42"]["pending"]
        self.assertEqual(pending["phase"], "store")
        self.assertEqual(pending["memories"], [{"content": "remember this", "namespace": "shared", "tags": ["decision", "general"]}])

        with mock.patch.object(sweep, "extract_messages", side_effect=AssertionError("must not read log")), \
             mock.patch.object(sweep, "extract_memories_llm", side_effect=AssertionError("must not rerun LLM")), \
             mock.patch.object(sweep, "store_memory", return_value=True) as store:
            self.assertEqual(sweep.run_sweep(args(), datetime(2026, 1, 1, 12, tzinfo=UTC)), 0)
        self.assertIn("idempotency_key", store.call_args.kwargs)
        channel = json.loads(self.state.read_text())["channels"]["42"]
        self.assertNotIn("pending", channel)
        self.assertEqual(channel["last_successful_end"], "2026-01-01T06:00:00+00:00")

    def test_failures_retain_pending_exit_nonzero_and_other_channels_advance(self):
        sweep.load_channel_map.return_value = {
            "bad": {"channel_id": "1", "session_file": "bad"},
            "good": {"channel_id": "2", "session_file": "good"},
        }
        with mock.patch.object(sweep, "extract_messages", return_value=(["a", "b", "c"], 0)), \
             mock.patch.object(sweep, "extract_memories_llm", side_effect=[sweep.SweepError("malformed"), []]):
            self.assertEqual(sweep.run_sweep(args(), datetime(2026, 1, 1, 6, tzinfo=UTC)), 1)
        channels = json.loads(self.state.read_text())["channels"]
        self.assertIn("pending", channels["1"])
        self.assertEqual(channels["2"]["last_successful_end"], "2026-01-01T06:00:00+00:00")

    def test_keyed_store_requires_server_acknowledgement(self):
        completed = subprocess_result = mock.Mock(returncode=0, stdout='{"id":"m-1","idempotency_key_honored":true}', stderr="")
        with mock.patch.object(sweep.subprocess, "run", return_value=completed):
            self.assertTrue(sweep.store_memory("x", "shared", [], "general", "key"))

        completed.stdout = json.dumps({"content": [{"type": "text", "text": '{"id":"m-1","idempotency_key_honored":true}'}]})
        with mock.patch.object(sweep.subprocess, "run", return_value=completed):
            self.assertTrue(sweep.store_memory("x", "shared", [], "general", "key"))

        for output in ('{"id":"m-1"}', '{"idempotency_key_honored":false}', '{"content":[{"type":"text","text":"{\\"id\\":\\"m-1\\"}"}]}', 'not json'):
            subprocess_result.stdout = output
            with mock.patch.object(sweep.subprocess, "run", return_value=subprocess_result):
                with self.assertRaisesRegex(sweep.SweepError, "idempotency acknowledgement"):
                    sweep.store_memory("x", "shared", [], "general", "key")

    def test_missing_store_ack_retains_pending_and_exits_nonzero(self):
        memory = {"content": "remember this", "namespace": "shared", "tags": []}
        with mock.patch.object(sweep, "extract_messages", return_value=(["a", "b", "c"], 0)), \
             mock.patch.object(sweep, "extract_memories_llm", return_value=[memory]), \
             mock.patch.object(sweep, "store_memory", side_effect=sweep.SweepError("missing idempotency acknowledgement")):
            self.assertEqual(sweep.run_sweep(args(), datetime(2026, 1, 1, 6, tzinfo=UTC)), 1)
        pending = json.loads(self.state.read_text())["channels"]["42"]["pending"]
        self.assertEqual(pending["phase"], "store")
        self.assertEqual(pending["next_index"], 0)

    def test_dry_run_never_touches_state_or_storage(self):
        self.state.parent.mkdir()
        self.state.write_bytes(b'{"legacy":true}\n')
        before = (self.state.read_bytes(), self.state.stat().st_mtime_ns)
        with mock.patch.object(sweep, "extract_messages", return_value=(["a", "b", "c"], 0)), \
             mock.patch.object(sweep, "extract_memories_llm", return_value=[{"content": "x"}]), \
             mock.patch.object(sweep, "store_memory") as store:
            self.assertEqual(sweep.run_sweep(args(dry_run=True), datetime(2026, 1, 1, 6, tzinfo=UTC)), 0)
        self.assertEqual((self.state.read_bytes(), self.state.stat().st_mtime_ns), before)
        store.assert_not_called()

    def test_dry_run_reports_corrupt_store_snapshot_as_sweep_error(self):
        self.state.parent.mkdir()
        self.state.write_text(json.dumps({
            "version": 2,
            "channels": {"42": {"last_successful_end": "2026-01-01T00:00:00+00:00", "pending": {
                "start": "2026-01-01T00:00:00+00:00", "end": "2026-01-01T06:00:00+00:00", "phase": "store"
            }}},
        }), encoding="utf-8")
        with self.assertRaisesRegex(sweep.SweepError, "corrupt pending store snapshot"):
            sweep.run_sweep(args(dry_run=True), datetime(2026, 1, 1, 6, tzinfo=UTC))

    def test_atomic_owner_only_state_and_locking(self):
        state = {"version": 2, "channels": {}}
        sweep.save_state(state)
        if os.name != "nt":  # Windows' stat mode does not expose ACL/chmod restrictions.
            self.assertEqual(stat.S_IMODE(self.state.parent.stat().st_mode) & 0o077, 0)
            self.assertEqual(stat.S_IMODE(self.state.stat().st_mode) & 0o077, 0)
        self.assertEqual(list(self.state.parent.glob("*.tmp")), [])
        lock = sweep.StateLock(self.state)
        with lock:
            with self.assertRaises(sweep.SweepError):
                with sweep.StateLock(self.state):
                    pass

    def test_legacy_migration_checkpoints_all_present_channels_before_processing(self):
        sweep.load_channel_map.return_value = {
            "alpha": {"channel_id": "1", "session_file": "alpha"},
            "beta": {"channel_id": "2", "session_file": "beta"},
        }
        self.state.parent.mkdir()
        self.state.write_text('{"last_sweep":"2026-01-01T00:00:00+00:00"}', encoding="utf-8")
        real_save = sweep.save_state

        def interrupt_after_save(state):
            real_save(state)
            raise KeyboardInterrupt("injected crash")

        with mock.patch.object(sweep, "save_state", side_effect=interrupt_after_save), \
             self.assertRaises(KeyboardInterrupt):
            sweep.run_sweep(args(), datetime(2026, 1, 1, 6, tzinfo=UTC))

        channels = json.loads(self.state.read_text())["channels"]
        self.assertEqual(channels["1"]["last_successful_end"], "2026-01-01T00:00:00+00:00")
        self.assertEqual(channels["2"]["last_successful_end"], "2026-01-01T00:00:00+00:00")

    def test_legacy_state_migrates_once_with_private_backup(self):
        self.state.parent.mkdir()
        self.state.write_text('{"last_sweep":"2026-01-01T00:00:00+00:00"}', encoding="utf-8")
        with mock.patch.object(sweep, "extract_messages", return_value=([], 0)) as extract:
            self.assertEqual(sweep.run_sweep(args(), datetime(2026, 1, 1, 6, tzinfo=UTC)), 0)
        self.assertEqual(extract.call_args.args[1], datetime(2026, 1, 1, 0, tzinfo=UTC))
        backup = self.state.with_suffix(self.state.suffix + ".v1.bak")
        self.assertTrue(backup.exists())
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(backup.stat().st_mode) & 0o077, 0)


if __name__ == "__main__":
    unittest.main()
