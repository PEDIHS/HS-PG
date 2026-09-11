#!/usr/bin/env python3
"""Privileged local-only backup bridge for HS Plugin.

The PasarGuard panel should never get Docker/root privileges. This agent runs
as root on the host, listens only on loopback, authenticates requests with a
shared random token, and only exposes the two fixed PasarGuard backup actions.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
import uuid
import zipfile
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = os.getenv("HS_BACKUP_AGENT_HOST", "127.0.0.1")
PORT = int(os.getenv("HS_BACKUP_AGENT_PORT", "8791"))
DATA_DIR = Path(os.getenv("HS_PLUGIN_DATA_DIR", "/var/lib/pasarguard/hs-plugin"))
STATE_FILE = DATA_DIR / "state.json"
TOKEN_FILE = DATA_DIR / "backup-agent.token"
LOCK_FILE = DATA_DIR / ".backup.lock"
INBOX_DIR = DATA_DIR / "backup-inbox"
OUTBOX_DIR = DATA_DIR / "backup-outbox"
JOBS_DIR = DATA_DIR / "backup-jobs"
PASARGUARD_DIR = Path(os.getenv("PASARGUARD_ROOT", "/opt/pasarguard"))
BACKUP_DIR = PASARGUARD_DIR / "backup"
PASARGUARD_BIN = Path(os.getenv("PASARGUARD_BIN", "/usr/local/bin/pasarguard"))
MAX_JSON_BODY = 64 * 1024
MAX_JOB_LOG = 24_000
MAX_OUTBOX_AGE = 24 * 60 * 60
WRAPPER_MANIFEST = "hs-backup-manifest.json"
WRAPPER_FORMAT = "hs-pg-backup-wrapper-v1"
ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
PART_RE = re.compile(r"^(?P<base>.+\.zip)\.part(?P<num>\d+)$")
_ID_RE = re.compile(r"^[0-9a-f]{32}$")

_OPERATION_LOCK = threading.Lock()


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def atomic_json(path: Path, value: dict, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def prepare_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for directory in (INBOX_DIR, OUTBOX_DIR, JOBS_DIR):
        directory.mkdir(parents=True, exist_ok=True)
        os.chmod(directory, 0o700)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)


def ensure_token() -> str:
    prepare_dirs()
    if TOKEN_FILE.is_file():
        token = TOKEN_FILE.read_text(encoding="utf-8").strip()
        if len(token) >= 48:
            return token
    token = secrets.token_urlsafe(48)
    TOKEN_FILE.write_text(token + "\n", encoding="utf-8")
    os.chmod(TOKEN_FILE, 0o600)
    return token


def backup_enabled() -> bool:
    try:
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return False
    return bool(state.get("features", {}).get("backup_web", {}).get("enabled", False))


def clean_output(value: str) -> str:
    value = ANSI_RE.sub("", value or "")
    if len(value) > MAX_JOB_LOG:
        value = value[-MAX_JOB_LOG:]
    return value


def validate_id(value: object, label: str = "id") -> str:
    value = str(value or "").strip().lower()
    if not _ID_RE.fullmatch(value):
        raise ValueError(f"Invalid {label}")
    return value


def cleanup_old_exports() -> None:
    cutoff = time.time() - MAX_OUTBOX_AGE
    for item in OUTBOX_DIR.iterdir():
        try:
            if item.is_dir() and item.stat().st_mtime < cutoff:
                shutil.rmtree(item, ignore_errors=True)
        except OSError:
            continue


def _native_backup_files(started_at: float) -> list[Path]:
    def eligible(path: Path) -> bool:
        return path.is_file() and (path.name.endswith(".zip") or PART_RE.match(path.name) is not None)

    recent = []
    for path in BACKUP_DIR.iterdir():
        try:
            if eligible(path) and path.stat().st_mtime >= started_at - 2:
                recent.append(path)
        except OSError:
            pass
    if recent:
        return sorted(recent, key=lambda p: p.name)

    fallback = []
    for path in BACKUP_DIR.iterdir():
        try:
            if eligible(path):
                fallback.append(path)
        except OSError:
            pass
    if not fallback:
        return []
    newest = max(fallback, key=lambda p: p.stat().st_mtime)
    match = PART_RE.match(newest.name)
    if not match:
        return [newest]
    base = match.group("base")
    return sorted(
        [p for p in fallback if PART_RE.match(p.name) and PART_RE.match(p.name).group("base") == base],
        key=lambda p: int(PART_RE.match(p.name).group("num")),
    )


def _run_native_backup() -> dict:
    if not PASARGUARD_BIN.is_file():
        raise RuntimeError("PasarGuard CLI was not found on the host")

    cleanup_old_exports()
    started = time.time()
    proc = subprocess.run(
        [str(PASARGUARD_BIN), "backup"],
        cwd=str(PASARGUARD_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=30 * 60,
        env={**os.environ, "TERM": "dumb", "NO_COLOR": "1"},
        check=False,
    )
    output = clean_output(proc.stdout)
    if proc.returncode != 0:
        raise RuntimeError(f"PasarGuard backup failed (exit {proc.returncode})\n{output[-4000:]}")

    files = _native_backup_files(started)
    if not files:
        raise RuntimeError("PasarGuard completed backup but no backup archive was found")

    export_id = uuid.uuid4().hex
    target_dir = OUTBOX_DIR / export_id
    target_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")

    split = len(files) > 1 or PART_RE.match(files[0].name) is not None
    if split:
        filename = f"pasarguard-backup-{stamp}-hs.zip"
        target = target_dir / filename
        primary = next((p.name for p in files if p.name.endswith(".zip.part01")), files[0].name)
        manifest = {
            "format": WRAPPER_FORMAT,
            "created_at": utc_now(),
            "primary": primary,
            "files": [p.name for p in files],
        }
        with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
            archive.writestr(WRAPPER_MANIFEST, json.dumps(manifest, ensure_ascii=False, indent=2))
            for source in files:
                archive.write(source, arcname=source.name)
    else:
        filename = f"pasarguard-backup-{stamp}.zip"
        target = target_dir / filename
        shutil.copy2(files[0], target)

    size = target.stat().st_size
    meta = {
        "id": export_id,
        "filename": filename,
        "size": size,
        "created_at": utc_now(),
        "split_source": split,
    }
    atomic_json(target_dir / "meta.json", meta)
    return {**meta, "native_output": output[-4000:]}


def job_file(job_id: str) -> Path:
    return JOBS_DIR / f"{validate_id(job_id, 'job id')}.json"


def write_job(job_id: str, **changes) -> dict:
    path = job_file(job_id)
    current = {}
    try:
        current = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        pass
    current.update(changes)
    current["id"] = job_id
    current["updated_at"] = utc_now()
    atomic_json(path, current)
    return current


def _safe_wrapper_files(zf: zipfile.ZipFile) -> tuple[list[str], str]:
    try:
        manifest = json.loads(zf.read(WRAPPER_MANIFEST).decode("utf-8"))
    except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("Invalid HS backup wrapper manifest") from exc
    if manifest.get("format") != WRAPPER_FORMAT:
        raise ValueError("Unsupported HS backup wrapper format")

    raw_files = manifest.get("files")
    primary = str(manifest.get("primary") or "")
    if not isinstance(raw_files, list) or not raw_files or primary not in raw_files:
        raise ValueError("Invalid HS backup wrapper file list")

    names = set(zf.namelist())
    files: list[str] = []
    for raw in raw_files:
        name = str(raw)
        if not name or Path(name).name != name or name not in names:
            raise ValueError("Unsafe or missing backup part in wrapper")
        if not (name.endswith(".zip") or PART_RE.match(name)):
            raise ValueError("Unsupported file inside backup wrapper")
        files.append(name)
    return files, primary


def _stage_import(upload: Path, job_id: str) -> tuple[Path, list[Path]]:
    if not upload.is_file() or not zipfile.is_zipfile(upload):
        raise ValueError("The uploaded file is not a valid ZIP backup")

    staged: list[Path] = []
    with zipfile.ZipFile(upload, "r") as zf:
        if WRAPPER_MANIFEST in zf.namelist():
            files, primary_name = _safe_wrapper_files(zf)
            prefix = f"hs-import-{job_id[:10]}-"
            for name in files:
                target = BACKUP_DIR / f"{prefix}{name}"
                with zf.open(name, "r") as source, target.open("wb") as dest:
                    shutil.copyfileobj(source, dest, length=1024 * 1024)
                os.chmod(target, 0o600)
                staged.append(target)
            primary = BACKUP_DIR / f"{prefix}{primary_name}"
            return primary, staged

    target = BACKUP_DIR / f"hs-import-{job_id[:10]}.zip"
    shutil.copy2(upload, target)
    os.chmod(target, 0o600)
    return target, [target]


def _restore_candidates() -> list[Path]:
    candidates = [
        p for p in BACKUP_DIR.iterdir()
        if p.is_file() and (p.name.endswith(".zip") or p.name.endswith(".zip.part01"))
    ]
    return sorted(candidates, key=lambda p: p.name, reverse=True)


def _restore_job(job_id: str, upload_id: str) -> None:
    upload_dir = INBOX_DIR / upload_id
    upload = upload_dir / "upload.zip"
    staged: list[Path] = []
    try:
        write_job(job_id, status="running", phase="staging", started_at=utc_now(), message="Validating backup archive")
        with _OPERATION_LOCK:
            if not backup_enabled():
                raise RuntimeError("Web Backup feature was disabled before restore started")
            if not PASARGUARD_BIN.is_file():
                raise RuntimeError("PasarGuard CLI was not found on the host")

            with LOCK_FILE.open("a+") as lock:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
                try:
                    primary, staged = _stage_import(upload, job_id)
                    candidates = _restore_candidates()
                    try:
                        choice = candidates.index(primary) + 1
                    except ValueError as exc:
                        raise RuntimeError("Staged backup could not be selected by PasarGuard restore") from exc

                    write_job(job_id, status="running", phase="restoring", message="PasarGuard restore is running")
                    proc = subprocess.run(
                        [str(PASARGUARD_BIN), "restore"],
                        cwd=str(PASARGUARD_DIR),
                        input=f"{choice}\ny\n",
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        text=True,
                        timeout=45 * 60,
                        env={**os.environ, "TERM": "dumb", "NO_COLOR": "1"},
                        check=False,
                    )
                    output = clean_output(proc.stdout)
                    if proc.returncode != 0:
                        raise RuntimeError(f"PasarGuard restore failed (exit {proc.returncode})\n{output[-8000:]}")
                    write_job(
                        job_id,
                        status="succeeded",
                        phase="complete",
                        finished_at=utc_now(),
                        message="Backup imported successfully",
                        output=output,
                    )
                finally:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
    except Exception as exc:
        write_job(
            job_id,
            status="failed",
            phase="failed",
            finished_at=utc_now(),
            message=str(exc)[:2000],
        )
    finally:
        for path in staged:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        shutil.rmtree(upload_dir, ignore_errors=True)


def start_import(upload_id: str) -> dict:
    upload_id = validate_id(upload_id, "upload id")
    upload = INBOX_DIR / upload_id / "upload.zip"
    if not upload.is_file():
        raise FileNotFoundError("Uploaded backup was not found")
    job_id = uuid.uuid4().hex
    write_job(
        job_id,
        status="queued",
        phase="queued",
        created_at=utc_now(),
        message="Restore queued",
    )
    thread = threading.Thread(target=_restore_job, args=(job_id, upload_id), daemon=True, name=f"hs-backup-{job_id[:8]}")
    thread.start()
    return {"job_id": job_id, "status": "queued"}


class Handler(BaseHTTPRequestHandler):
    server_version = "HSBackupAgent/1.0"

    def log_message(self, fmt: str, *args) -> None:
        return

    def _send(self, status_code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        supplied = self.headers.get("X-HS-Backup-Token", "")
        return secrets.compare_digest(supplied, self.server.agent_token)

    def _read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Invalid Content-Length") from exc
        if length <= 0 or length > MAX_JSON_BODY:
            raise ValueError("Invalid request body size")
        try:
            value = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Invalid JSON body") from exc
        if not isinstance(value, dict):
            raise ValueError("JSON body must be an object")
        return value

    def _gate(self) -> bool:
        if not self._authorized():
            self._send(403, {"detail": "Forbidden"})
            return False
        if not backup_enabled():
            self._send(403, {"detail": "Web Backup feature is disabled"})
            return False
        return True

    def do_GET(self) -> None:
        if self.path != "/health":
            self._send(404, {"detail": "Not found"})
            return
        if not self._authorized():
            self._send(403, {"detail": "Forbidden"})
            return
        self._send(200, {
            "ok": True,
            "enabled": backup_enabled(),
            "busy": _OPERATION_LOCK.locked(),
            "version": 1,
        })

    def do_POST(self) -> None:
        if not self._gate():
            return
        try:
            if self.path == "/export":
                if not _OPERATION_LOCK.acquire(blocking=False):
                    self._send(409, {"detail": "Another backup operation is already running"})
                    return
                try:
                    with LOCK_FILE.open("a+") as lock:
                        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
                        try:
                            result = _run_native_backup()
                        finally:
                            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
                finally:
                    _OPERATION_LOCK.release()
                self._send(200, result)
                return

            if self.path == "/import":
                data = self._read_json()
                result = start_import(data.get("upload_id"))
                self._send(202, result)
                return

            self._send(404, {"detail": "Not found"})
        except FileNotFoundError as exc:
            self._send(404, {"detail": str(exc)})
        except ValueError as exc:
            self._send(422, {"detail": str(exc)})
        except subprocess.TimeoutExpired:
            self._send(504, {"detail": "PasarGuard backup operation timed out"})
        except Exception as exc:
            self._send(500, {"detail": str(exc)[:4000]})


def main() -> None:
    token = ensure_token()
    cleanup_old_exports()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.agent_token = token
    os.chmod(TOKEN_FILE, 0o600)
    server.serve_forever(poll_interval=0.5)


if __name__ == "__main__":
    main()
