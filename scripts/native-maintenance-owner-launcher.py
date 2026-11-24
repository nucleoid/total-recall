#!/usr/bin/env python3
"""Fixed, passwordless, resource-capped host launcher for one maintenance page."""

import fcntl
import os
from pathlib import Path
import stat
import subprocess
import sys

EXPECTED_UID = 999
EXPECTED_GID = 994
DOCKER = "/usr/bin/docker"
RELEASE = Path("/home/cass/total-recall-move-20261117/release")
JOB_DIR = Path("/home/cass/total-recall-native-maintenance-owner")
LOCK_PATH = JOB_DIR / "launcher.lock"
INGESTION_CONTAINER = "total-recall-ingestion-worker-1"
DATABASE_CONTAINER = "total-recall-db-1"
DATABASE_URL = "postgresql://postgres@127.0.0.1:5432/total_recall"
CONTAINER_NAME = "total-recall-native-maintenance-owner"


def fail(message: str) -> "NoReturn":
    raise SystemExit(f"native maintenance launcher: {message}")


def inspect_value(container: str, template: str) -> str:
    result = subprocess.run(
        [DOCKER, "inspect", "--format", template, container],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    if result.returncode != 0 or not result.stdout.strip():
        fail(f"required container unavailable: {container}")
    return result.stdout.strip()


def require_trusted_directory(path: Path, mode: int, create: bool = False) -> None:
    if create and not path.exists():
        path.mkdir(mode=mode)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        fail(f"trusted path is not a real directory: {path}")
    if info.st_uid != EXPECTED_UID or info.st_gid != EXPECTED_GID:
        fail(f"trusted path owner mismatch: {path}")
    if stat.S_IMODE(info.st_mode) != mode:
        fail(f"trusted path mode mismatch: {path}")


def main() -> int:
    if len(sys.argv) != 1:
        fail("arguments are not supported")
    if os.geteuid() != EXPECTED_UID or os.getegid() != EXPECTED_GID:
        fail("must run as the fixed cass OS identity 999:994")
    if not Path(DOCKER).is_file():
        fail("fixed docker binary is unavailable")
    require_trusted_directory(RELEASE, 0o755)
    require_trusted_directory(JOB_DIR, 0o700, create=True)
    for required in (
        RELEASE / "scripts/native-maintenance-owner.ts",
        RELEASE / "node_modules/tsx/dist/cli.mjs",
    ):
        info = required.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != EXPECTED_UID or info.st_mode & 0o022:
            fail(f"untrusted release file: {required}")

    lock_fd = os.open(LOCK_PATH, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        lock_info = os.fstat(lock_fd)
        if not stat.S_ISREG(lock_info.st_mode) or lock_info.st_uid != EXPECTED_UID or stat.S_IMODE(lock_info.st_mode) != 0o600:
            fail("lock file ownership or mode mismatch")
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail("another maintenance invocation holds the shared-kernel lock")

        if inspect_value(INGESTION_CONTAINER, "{{.State.Running}}") != "true":
            fail("trusted ingestion container is not running")
        if inspect_value(DATABASE_CONTAINER, "{{.State.Running}}") != "true":
            fail("database container is not running")
        image_id = inspect_value(INGESTION_CONTAINER, "{{.Image}}")
        if not image_id.startswith("sha256:") or len(image_id) != 71:
            fail("trusted ingestion container returned an invalid image identity")

        command = [
            DOCKER, "run", "--rm", "-i", "--pull=never", "--name", CONTAINER_NAME,
            "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "--memory=256m", "--cpus=0.25", "--pids-limit=64",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=32m",
            "--network", f"container:{DATABASE_CONTAINER}",
            "--user", f"{EXPECTED_UID}:{EXPECTED_GID}", "--workdir", "/app",
            "--mount", f"type=bind,src={RELEASE},dst=/app,readonly",
            "--mount", f"type=bind,src={JOB_DIR},dst=/job",
            "--env", f"DATABASE_URL={DATABASE_URL}",
            "--env", f"MAINTENANCE_DATABASE_URL={DATABASE_URL}",
            "--env", "NODE_ENV=production",
            image_id,
            "node", "/app/node_modules/tsx/dist/cli.mjs", "/app/scripts/native-maintenance-owner.ts",
        ]
        return subprocess.run(command, check=False).returncode
    finally:
        os.close(lock_fd)


if __name__ == "__main__":
    raise SystemExit(main())
