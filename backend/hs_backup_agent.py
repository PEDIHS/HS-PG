#!/usr/bin/env python3
"""Privileged local-only backup bridge for HS Plugin.

The PasarGuard panel never receives Docker/root privileges. This agent runs as
root on the host, listens only on loopback, authenticates every request with a
shared random token, and only exposes fixed backup/restore operations backed by
PasarGuard's own CLI.
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
PRESERVE_ROOT = Path(os.getenv("HS_BACKUP_PRESERVE_ROOT", "/var/lib/hs-pg"))
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
UPLOAD_MANIFEST = "upload-manifest.json"
WRAPPER_MANIFEST = "hs-backup-manifest.json"
WRAPPER_FORMAT = "hs-pg-backup-wrapper-v1"
ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
PART_RE = re.compile(r"^(?P<base>.+)\.part(?P<num>\d{2})\.zip$", re.IGNORECASE)
ZIP_SPLIT_RE = re.compile(r"^(?P<base>.+)\.z(?P<num>\d{2})$", re.IGNORECASE)
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
    os.chmod(DATA_DIR, 0o700)
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
    if not OUTBOX_DIR.exists():
        return
    for item in OUTBOX_DIR.iterdir():
        try:
            if item.is_dir() and item.stat().st_mtime < cutoff:
                shutil.rmtree(item, ignore_errors=True)
        except OSError:
            continue


def _native_group(paths: list[Path]) -> list[Path]:
    """Pick the newest complete native backup artifact/group."""
    if not paths:
        return []

    groups: dict[str, list[tuple[int, Path]]] = {}
    singles: list[Path] = []
    for path in paths:
        match = PART_RE.match(path.name)
        if match:
            groups.setdefault(match.group("base"), []).append((int(match.group("num")), path))
        elif path.name.lower().endswith(".zip"):
            singles.append(path)

    choices: list[tuple[float, list[Path]]] = []
    for parts in groups.values():
        ordered = [path for _, path in sorted(parts, key=lambda item: item[0])]
        if ordered:
            choices.append((max(path.stat().st_mtime for path in ordered), ordered))
    for path in singles:
        choices.append((path.stat().st_mtime, [path]))
    return max(choices, key=lambda item: item[0])[1] if choices else []


def _native_backup_files(started_at: float) -> list[Path]:
    paths: list[Path] = []
    for path in BACKUP_DIR.iterdir():
        try:
            if path.is_file() and (path.name.lower().endswith(".zip") or PART_RE.match(path.name)) and path.stat().st_mtime >= started_at - 2:
                paths.append(path)
        except OSError:
            continue
    selected = _native_group(paths)
    if selected:
        return selected

    fallback: list[Path] = []
    for path in BACKUP_DIR.iterdir():
        try:
            if path.is_file() and (path.name.lower().endswith(".zip") or PART_RE.match(path.name)):
                fallback.append(path)
        except OSError:
            continue
    return _native_group(fallback)


def _combined_native_zip(files: list[Path], work_dir: Path) -> tuple[Path, bool]:
    if not files:
        raise RuntimeError("No native backup files were found")
    split = len(files) > 1 or PART_RE.match(files[0].name) is not None
    if not split:
        return files[0], False

    ordered = sorted(
        files,
        key=lambda path: int(PART_RE.match(path.name).group("num")) if PART_RE.match(path.name) else 0,
    )
    combined = work_dir / ".native-combined.zip"
    with combined.open("wb") as dest:
        for source in ordered:
            with source.open("rb") as src:
                shutil.copyfileobj(src, dest, length=1024 * 1024)
    if not zipfile.is_zipfile(combined):
        raise RuntimeError("PasarGuard split backup could not be recombined into a valid ZIP")
    return combined, True


def _skip_export_member(name: str) -> bool:
    normalized = name.replace("\\", "/").lstrip("./")
    return normalized == "pasarguard_data/hs-plugin" or normalized.startswith("pasarguard_data/hs-plugin/")


def _sanitize_backup_zip(source: Path, target: Path) -> None:
    """Stream-copy a native backup while excluding HS runtime/secrets.

    The result remains a normal PasarGuard-compatible ZIP. This avoids leaking
    the backup-agent token and avoids recursively carrying HS inbox/outbox data.
    """
    if not zipfile.is_zipfile(source):
        raise RuntimeError("PasarGuard backup is not a valid ZIP archive")

    with zipfile.ZipFile(source, "r") as src, zipfile.ZipFile(target, "w", allowZip64=True) as dst:
        for info in src.infolist():
            if _skip_export_member(info.filename):
                continue
            if info.is_dir():
                dst.writestr(info, b"")
                continue
            with src.open(info, "r") as read_handle, dst.open(info, "w", force_zip64=True) as write_handle:
                shutil.copyfileobj(read_handle, write_handle, length=1024 * 1024)

    if not zipfile.is_zipfile(target):
        raise RuntimeError("Sanitized backup archive failed ZIP validation")


def _run_native_backup() -> dict:
    if not PASARGUARD_BIN.is_file():
        raise RuntimeError("PasarGuard CLI was not found on the host")

    prepare_dirs()
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
    filename = f"pasarguard-backup-{stamp}-hs.zip"
    target = target_dir / filename

    combined, split_source = _combined_native_zip(files, target_dir)
    try:
        _sanitize_backup_zip(combined, target)
    finally:
        if combined.parent == target_dir and combined.name.startswith(".native-combined"):
            combined.unlink(missing_ok=True)

    size = target.stat().st_size
    meta = {
        "id": export_id,
        "filename": filename,
        "size": size,
        "created_at": utc_now(),
        "split_source": split_source,
    }
    atomic_json(target_dir / "meta.json", meta)
    return {**meta, "native_output": output[-4000:]}


def job_file(job_id: str) -> Path:
    return JOBS_DIR / f"{validate_id(job_id, 'job id')}.json"


def write_job(job_id: str, **changes) -> dict:
    prepare_dirs()
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
        if not (name.lower().endswith(".zip") or PART_RE.match(name) or ZIP_SPLIT_RE.match(name)):
            raise ValueError("Unsupported file inside backup wrapper")
        files.append(name)
    return files, primary


def _load_upload_manifest(upload_id: str) -> list[tuple[str, Path]]:
    upload_dir = INBOX_DIR / validate_id(upload_id, "upload id")
    manifest_path = upload_dir / UPLOAD_MANIFEST
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError) as exc:
        raise FileNotFoundError("Uploaded backup manifest was not found") from exc

    entries = manifest.get("files") if isinstance(manifest, dict) else None
    if not isinstance(entries, list) or not entries:
        raise ValueError("Uploaded backup manifest is invalid")

    result: list[tuple[str, Path]] = []
    seen_names: set[str] = set()
    for item in entries:
        if not isinstance(item, dict):
            raise ValueError("Uploaded backup manifest contains an invalid file")
        original = Path(str(item.get("name") or "")).name
        stored = Path(str(item.get("stored") or "")).name
        if not original or original != item.get("name") or not stored or stored != item.get("stored"):
            raise ValueError("Uploaded backup filename is unsafe")
        if original.lower() in seen_names:
            raise ValueError("Duplicate backup part filename")
        path = upload_dir / stored
        if not path.is_file() or path.stat().st_size <= 0:
            raise ValueError(f"Uploaded backup part is missing: {original}")
        seen_names.add(original.lower())
        result.append((original, path))
    return result


def _validate_native_parts(items: list[tuple[str, Path]]) -> tuple[str, list[tuple[int, Path]]]:
    parsed: list[tuple[str, int, Path]] = []
    for name, path in items:
        match = PART_RE.match(name)
        if not match:
            raise ValueError("Selected files are not one PasarGuard .partNN.zip backup set")
        parsed.append((match.group("base"), int(match.group("num")), path))

    bases = {base.lower() for base, _, _ in parsed}
    if len(bases) != 1:
        raise ValueError("All split backup parts must belong to the same backup")
    nums = sorted(num for _, num, _ in parsed)
    start = nums[0]
    if start not in {0, 1} or nums != list(range(start, start + len(nums))):
        raise ValueError("Split backup parts are incomplete or not contiguous")
    return parsed[0][0], sorted([(num, path) for _, num, path in parsed], key=lambda item: item[0])


def _validate_legacy_zip_split(items: list[tuple[str, Path]]) -> tuple[Path, list[tuple[int, Path]]]:
    mains = [(name, path) for name, path in items if name.lower().endswith(".zip") and not PART_RE.match(name)]
    parts = []
    for name, path in items:
        match = ZIP_SPLIT_RE.match(name)
        if match:
            parts.append((match.group("base"), int(match.group("num")), path))
    if len(mains) != 1 or len(parts) != len(items) - 1 or not parts:
        raise ValueError("Selected files are not a supported split ZIP backup")
    main_name, main_path = mains[0]
    main_base = main_name[:-4]
    if any(base.lower() != main_base.lower() for base, _, _ in parts):
        raise ValueError("Split ZIP parts do not match the main ZIP file")
    ordered = sorted([(num, path) for _, num, path in parts], key=lambda item: item[0])
    nums = [num for num, _ in ordered]
    if nums != list(range(1, len(nums) + 1)):
        raise ValueError("Split ZIP parts are incomplete or not contiguous")
    return main_path, ordered


def _copy_to_backup(source: Path, target: Path) -> Path:
    shutil.copyfile(source, target)
    os.chmod(target, 0o600)
    return target


def _stage_sources(items: list[tuple[str, Path]], job_id: str) -> tuple[Path, list[Path]]:
    if not items:
        raise ValueError("No backup file was uploaded")

    prefix = f"hs-backup-import-{job_id[:10]}"
    staged: list[Path] = []

    if len(items) == 1:
        name, source = items[0]
        if PART_RE.match(name):
            raise ValueError("A split PasarGuard backup requires all .partNN.zip files")
        if ZIP_SPLIT_RE.match(name):
            raise ValueError("A split ZIP backup requires the main .zip file and all .zNN parts")
        if not name.lower().endswith(".zip") or not zipfile.is_zipfile(source):
            raise ValueError("The uploaded file is not a valid ZIP backup")
        target = _copy_to_backup(source, BACKUP_DIR / f"{prefix}.zip")
        return target, [target]

    if all(PART_RE.match(name) for name, _ in items):
        _base, parts = _validate_native_parts(items)
        for num, source in parts:
            target = _copy_to_backup(source, BACKUP_DIR / f"{prefix}.part{num:02d}.zip")
            staged.append(target)
        return staged[0], staged

    main_path, parts = _validate_legacy_zip_split(items)
    for num, source in parts:
        staged.append(_copy_to_backup(source, BACKUP_DIR / f"{prefix}.z{num:02d}"))
    primary = _copy_to_backup(main_path, BACKUP_DIR / f"{prefix}.zip")
    staged.append(primary)
    return primary, staged


def _stage_import(upload_id: str, job_id: str) -> tuple[Path, list[Path]]:
    items = _load_upload_manifest(upload_id)
    if len(items) == 1 and zipfile.is_zipfile(items[0][1]):
        with zipfile.ZipFile(items[0][1], "r") as zf:
            if WRAPPER_MANIFEST in zf.namelist():
                names, _primary_name = _safe_wrapper_files(zf)
                extracted_dir = INBOX_DIR / upload_id / "wrapper"
                extracted_dir.mkdir(mode=0o700, exist_ok=True)
                extracted: list[tuple[str, Path]] = []
                for index, name in enumerate(names):
                    target = extracted_dir / f"part-{index:04d}.bin"
                    with zf.open(name, "r") as src, target.open("wb") as dest:
                        shutil.copyfileobj(src, dest, length=1024 * 1024)
                    os.chmod(target, 0o600)
                    extracted.append((name, target))
                return _stage_sources(extracted, job_id)
    return _stage_sources(items, job_id)


def _find_native_restore_candidates() -> list[Path]:
    """Mirror PasarGuard restore's `find` order and split-file filtering."""
    primary_expr = [
        "find", str(BACKUP_DIR), "-maxdepth", "1", "(",
        "-name", "*backup*.gz", "-o",
        "-name", "*backup*.tar.gz", "-o",
        "-name", "*.tar.gz", "-o",
        "-name", "*backup*.zip", "-o",
        "-name", "*.zip", ")", "-type", "f", "-print0",
    ]
    fallback_expr = [
        "find", str(BACKUP_DIR), "-maxdepth", "1", "(",
        "-name", "*.gz", "-o", "-name", "*.zip", ")", "-type", "f", "-print0",
    ]

    def run_find(args: list[str]) -> list[Path]:
        proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
        return [Path(raw.decode(errors="surrogateescape")) for raw in proc.stdout.split(b"\0") if raw]

    candidates = run_find(primary_expr)
    if not candidates:
        candidates = run_find(fallback_expr)

    filtered: list[Path] = []
    for path in candidates:
        match = PART_RE.match(path.name)
        if match:
            base = match.group("base")
            first_num = 0 if (BACKUP_DIR / f"{base}.part00.zip").is_file() else 1
            if int(match.group("num")) != first_num:
                continue
        if ZIP_SPLIT_RE.match(path.name):
            continue
        filtered.append(path)
    return filtered


def _snapshot_hs_runtime(job_id: str) -> Path:
    """Keep destination HS state/token outside PasarGuard's --delete restore."""
    PRESERVE_ROOT.mkdir(parents=True, exist_ok=True)
    os.chmod(PRESERVE_ROOT, 0o700)
    target = PRESERVE_ROOT / f"restore-{job_id}"
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    target.mkdir(mode=0o700)
    for source in (STATE_FILE, TOKEN_FILE):
        if source.is_file():
            shutil.copy2(source, target / source.name)
            os.chmod(target / source.name, 0o600)
    return target


def _restore_hs_runtime(snapshot: Path | None) -> None:
    prepare_dirs()
    if snapshot is not None and snapshot.is_dir():
        for name in (STATE_FILE.name, TOKEN_FILE.name):
            source = snapshot / name
            if source.is_file():
                shutil.copy2(source, DATA_DIR / name)
                os.chmod(DATA_DIR / name, 0o600)

    # Imported PasarGuard data must not replace destination HS ephemeral state.
    for directory in (INBOX_DIR, OUTBOX_DIR, JOBS_DIR):
        shutil.rmtree(directory, ignore_errors=True)
        directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        os.chmod(directory, 0o700)

    if snapshot is not None:
        shutil.rmtree(snapshot, ignore_errors=True)


def _restore_job(job_id: str, upload_id: str) -> None:
    upload_dir = INBOX_DIR / upload_id
    staged: list[Path] = []
    snapshot: Path | None = None
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
                    primary, staged = _stage_import(upload_id, job_id)
                    candidates = _find_native_restore_candidates()
                    try:
                        choice = candidates.index(primary) + 1
                    except ValueError as exc:
                        raise RuntimeError("Staged backup could not be selected by PasarGuard restore") from exc

                    snapshot = _snapshot_hs_runtime(job_id)
                    write_job(job_id, status="running", phase="restoring", message="PasarGuard restore is running")
                    proc = subprocess.run(
                        [str(PASARGUARD_BIN), "restore"],
                        cwd=str(PASARGUARD_DIR),
                        input=f"{choice}\nyes\n",
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        text=True,
                        timeout=45 * 60,
                        env={**os.environ, "TERM": "dumb", "NO_COLOR": "1"},
                        check=False,
                    )
                    output = clean_output(proc.stdout)
                    _restore_hs_runtime(snapshot)
                    snapshot = None
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
        try:
            if snapshot is not None:
                _restore_hs_runtime(snapshot)
                snapshot = None
            write_job(
                job_id,
                status="failed",
                phase="failed",
                finished_at=utc_now(),
                message=str(exc)[:2000],
            )
        except Exception:
            pass
    finally:
        for path in staged:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        shutil.rmtree(upload_dir, ignore_errors=True)


def start_import(upload_id: str) -> dict:
    upload_id = validate_id(upload_id, "upload id")
    _load_upload_manifest(upload_id)
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
    server_version = "HSBackupAgent/2.0"

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
            "version": 2,
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
