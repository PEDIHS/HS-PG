"""Owner-only Web Backup API for HS Plugin."""
from __future__ import annotations

import fcntl
import http.client
import json
import os
import re
import secrets
import shutil
import time
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import unquote

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.datastructures import UploadFile

from app.models.admin import AdminDetails
from app.routers.authentication import get_current

router = APIRouter(tags=["HS Plugin Backup"], prefix="/api/hs-plugin/backup")

DATA_DIR = Path(os.getenv("HS_PLUGIN_DATA_DIR", "/var/lib/pasarguard/hs-plugin"))
STATE_FILE = DATA_DIR / "state.json"
STATE_LOCK_FILE = DATA_DIR / ".state.lock"
TOKEN_FILE = DATA_DIR / "backup-agent.token"
INBOX_DIR = DATA_DIR / "backup-inbox"
OUTBOX_DIR = DATA_DIR / "backup-outbox"
JOBS_DIR = DATA_DIR / "backup-jobs"
AGENT_HOST = os.getenv("HS_BACKUP_AGENT_HOST", "127.0.0.1")
AGENT_PORT = int(os.getenv("HS_BACKUP_AGENT_PORT", "8791"))
MAX_UPLOAD_BYTES = int(os.getenv("HS_BACKUP_MAX_UPLOAD_BYTES", str(8 * 1024 * 1024 * 1024)))
UPLOAD_MANIFEST = "upload-manifest.json"
DOWNLOAD_TICKET_TTL = 120
_ID_CHARS = frozenset("0123456789abcdef")
PART_RE = re.compile(r"^.+\.part\d{2}\.zip$", re.IGNORECASE)
ZIP_SPLIT_RE = re.compile(r"^.+\.z\d{2}$", re.IGNORECASE)


class ToggleBody(BaseModel):
    enabled: bool


def _require_owner(current_admin: AdminDetails | None = Depends(get_current)) -> AdminDetails:
    if current_admin is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    if not current_admin.role or not current_admin.role.is_owner:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="HS Plugin settings are owner-only")
    return current_admin


def _default_state() -> dict:
    return {
        "version": 2,
        "features": {
            "host_usage_ratio": {"enabled": True},
            "node_pro": {"enabled": False},
            "backup_web": {"enabled": False},
        },
        "inbound_offsets": {},
        "updated_at": None,
    }


def _load_state() -> dict:
    try:
        value = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise TypeError
    except (OSError, json.JSONDecodeError, TypeError):
        value = _default_state()
    value.setdefault("version", 2)
    features = value.setdefault("features", {})
    features.setdefault("host_usage_ratio", {"enabled": True})
    features.setdefault("node_pro", {"enabled": False})
    features.setdefault("backup_web", {"enabled": False})
    value.setdefault("inbound_offsets", {})
    value.setdefault("updated_at", None)
    return value


@contextmanager
def _state_lock():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with STATE_LOCK_FILE.open("a+", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def _save_state(value: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    value["updated_at"] = datetime.now(UTC).isoformat()
    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, STATE_FILE)


def _feature_enabled() -> bool:
    return bool(_load_state().get("features", {}).get("backup_web", {}).get("enabled", False))


def _require_feature() -> None:
    if not _feature_enabled():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Web Backup is disabled in HS Plugin")


def _safe_id(value: str, label: str = "id") -> str:
    value = str(value or "").strip().lower()
    if len(value) != 32 or any(char not in _ID_CHARS for char in value):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Invalid {label}")
    return value


def _agent_token() -> str:
    try:
        token = TOKEN_FILE.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="HS Backup agent is not initialized",
        ) from exc
    if len(token) < 48:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="HS Backup agent token is invalid",
        )
    return token


def _agent_request(method: str, path: str, payload: dict | None = None, timeout: int = 10) -> tuple[int, dict]:
    body = None
    headers = {
        "X-HS-Backup-Token": _agent_token(),
        "Accept": "application/json",
    }
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
        headers["Content-Length"] = str(len(body))

    connection = http.client.HTTPConnection(AGENT_HOST, AGENT_PORT, timeout=timeout)
    try:
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        raw = response.read()
    except (OSError, TimeoutError, http.client.HTTPException) as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="HS Backup agent is unavailable",
        ) from exc
    finally:
        connection.close()

    try:
        data = json.loads(raw.decode("utf-8")) if raw else {}
    except (UnicodeDecodeError, json.JSONDecodeError):
        data = {"detail": "Invalid response from HS Backup agent"}

    if not isinstance(data, dict):
        data = {"detail": "Invalid response from HS Backup agent"}
    return response.status, data


def _raise_agent(status_code: int, data: dict) -> None:
    if 200 <= status_code < 300:
        return
    detail = str(data.get("detail") or "HS Backup agent request failed")[:4000]
    mapped = status_code if 400 <= status_code <= 599 else status.HTTP_502_BAD_GATEWAY
    raise HTTPException(status_code=mapped, detail=detail)


def _safe_upload_name(value: str) -> str:
    name = Path(unquote(value or "")).name
    if not name or name in {".", ".."}:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Backup filename is invalid")
    lowered = name.lower()
    if not (lowered.endswith(".zip") or PART_RE.match(name) or ZIP_SPLIT_RE.match(name)):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Only PasarGuard ZIP, .partNN.zip, or .zNN backup files can be imported",
        )
    return name


def _write_upload_manifest(upload_dir: Path, files: list[dict]) -> None:
    target = upload_dir / UPLOAD_MANIFEST
    tmp = target.with_suffix(".tmp")
    tmp.write_text(json.dumps({"version": 1, "files": files}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, target)


async def _save_streamed_file(upload_dir: Path, index: int, name: str, reader, current_total: int) -> tuple[dict, int]:
    stored = f"part-{index:04d}.bin"
    target = upload_dir / stored
    size = 0
    with target.open("wb") as dest:
        while True:
            chunk = await reader(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            current_total += len(chunk)
            if current_total > MAX_UPLOAD_BYTES:
                raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Backup upload is too large")
            dest.write(chunk)
    if size <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Backup file is empty: {name}")
    os.chmod(target, 0o600)
    return {"name": name, "stored": stored, "size": size}, current_total


def _export_file(export_id: str) -> tuple[Path, str, Path]:
    export_id = _safe_id(export_id, "export id")
    directory = OUTBOX_DIR / export_id
    meta_path = directory / "meta.json"
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError) as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Backup export was not found") from exc

    filename = Path(str(meta.get("filename") or "")).name
    if not filename or filename != meta.get("filename"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Backup export metadata is invalid")
    file_path = directory / filename
    if not file_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Backup export file was not found")
    return directory, filename, file_path


def _backup_file_response(filename: str, file_path: Path) -> FileResponse:
    return FileResponse(
        path=file_path,
        media_type="application/zip",
        filename=filename,
        headers={
            "Cache-Control": "no-store, private",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/feature")
async def get_feature(_owner: AdminDetails = Depends(_require_owner)):
    state = _load_state()
    return {
        "enabled": bool(state.get("features", {}).get("backup_web", {}).get("enabled", False)),
        "updated_at": state.get("updated_at"),
    }


@router.put("/feature")
async def set_feature(
    body: ToggleBody,
    _owner: AdminDetails = Depends(_require_owner),
):
    with _state_lock():
        state = _load_state()
        state.setdefault("features", {}).setdefault("backup_web", {})["enabled"] = body.enabled
        _save_state(state)
    return {
        "ok": True,
        "feature": "backup_web",
        "enabled": body.enabled,
        "requires_restart": False,
    }


@router.get("/status")
async def backup_status(_owner: AdminDetails = Depends(_require_owner)):
    enabled = _feature_enabled()
    if not enabled:
        return {"enabled": False, "available": False, "busy": False}

    code, data = _agent_request("GET", "/health", timeout=4)
    _raise_agent(code, data)
    return {
        "enabled": True,
        "available": bool(data.get("ok")),
        "busy": bool(data.get("busy")),
        "agent_version": data.get("version"),
    }


@router.post("/export")
async def export_backup(_owner: AdminDetails = Depends(_require_owner)):
    _require_feature()
    code, data = _agent_request("POST", "/export", {}, timeout=30 * 60 + 30)
    _raise_agent(code, data)
    return {
        "id": data.get("id"),
        "filename": data.get("filename"),
        "size": data.get("size"),
        "created_at": data.get("created_at"),
        "split_source": bool(data.get("split_source")),
    }


@router.get("/download/{export_id}")
async def download_backup(
    export_id: str,
    _owner: AdminDetails = Depends(_require_owner),
):
    _require_feature()
    _directory, filename, file_path = _export_file(export_id)
    return _backup_file_response(filename, file_path)


@router.post("/ticket/{export_id}")
async def create_download_ticket(
    export_id: str,
    _owner: AdminDetails = Depends(_require_owner),
):
    """Create a short-lived one-use ticket so the browser can stream a large file.

    This avoids buffering multi-gigabyte backups into a JavaScript Blob merely
    to attach the localStorage Authorization header.
    """
    _require_feature()
    directory, _filename, _file_path = _export_file(export_id)
    ticket = secrets.token_urlsafe(32)
    payload = {"ticket": ticket, "expires_at": time.time() + DOWNLOAD_TICKET_TTL}
    path = directory / ".download-ticket.json"
    tmp = directory / ".download-ticket.tmp"
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    return {"ticket": ticket, "expires_in": DOWNLOAD_TICKET_TTL}


@router.get("/download-ticketed/{export_id}")
async def download_backup_ticketed(export_id: str, ticket: str):
    """Consume a one-use download ticket; no session/JWT is exposed in the URL."""
    if not _feature_enabled():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Backup export was not found")
    directory, filename, file_path = _export_file(export_id)
    path = directory / ".download-ticket.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        expected = str(payload.get("ticket") or "")
        expires_at = float(payload.get("expires_at") or 0)
    except (OSError, json.JSONDecodeError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Download ticket is invalid") from exc
    if expires_at < time.time() or not expected or not secrets.compare_digest(expected, str(ticket or "")):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Download ticket is invalid or expired")
    path.unlink(missing_ok=True)
    return _backup_file_response(filename, file_path)


@router.post("/import")
async def import_backup(
    request: Request,
    x_hs_backup_filename: str | None = Header(default=None, alias="X-HS-Backup-Filename"),
    _owner: AdminDetails = Depends(_require_owner),
):
    """Stream one normal ZIP or a complete native split-backup set to the host.

    Multipart requests use repeated `files` fields. The legacy raw-body format
    remains accepted so upgrades do not break an already-open older dashboard.
    """
    _require_feature()
    content_type = request.headers.get("content-type", "").lower()
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            declared = int(content_length)
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid Content-Length") from exc
        if declared <= 0:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Backup upload is empty")
        if declared > MAX_UPLOAD_BYTES + 4 * 1024 * 1024:
            raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Backup upload is too large")

    upload_id = uuid.uuid4().hex
    upload_dir = INBOX_DIR / upload_id
    upload_dir.mkdir(parents=True, exist_ok=False)
    os.chmod(upload_dir, 0o700)
    saved: list[dict] = []
    total = 0
    uploads: list[UploadFile] = []

    try:
        if content_type.startswith("multipart/form-data"):
            form = await request.form()
            candidates = form.getlist("files")
            uploads = [item for item in candidates if isinstance(item, UploadFile)]
            if not uploads:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No backup files were uploaded")
            if len(uploads) > 256:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Too many backup parts")

            seen: set[str] = set()
            for index, upload in enumerate(uploads):
                name = _safe_upload_name(upload.filename or "")
                key = name.lower()
                if key in seen:
                    raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"Duplicate backup part: {name}")
                seen.add(key)
                entry, total = await _save_streamed_file(upload_dir, index, name, upload.read, total)
                saved.append(entry)
        else:
            name = _safe_upload_name(x_hs_backup_filename or "backup.zip")
            stored = upload_dir / "part-0000.bin"
            size = 0
            with stored.open("wb") as dest:
                async for chunk in request.stream():
                    if not chunk:
                        continue
                    size += len(chunk)
                    total += len(chunk)
                    if total > MAX_UPLOAD_BYTES:
                        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Backup upload is too large")
                    dest.write(chunk)
            if size <= 0:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Backup file is empty")
            os.chmod(stored, 0o600)
            saved.append({"name": name, "stored": stored.name, "size": size})

        _write_upload_manifest(upload_dir, saved)
        code, data = _agent_request("POST", "/import", {"upload_id": upload_id}, timeout=10)
        _raise_agent(code, data)
        return {
            "job_id": data.get("job_id"),
            "status": data.get("status", "queued"),
            "files": [{"name": item["name"], "size": item["size"]} for item in saved],
            "size": total,
        }
    except Exception:
        shutil.rmtree(upload_dir, ignore_errors=True)
        raise
    finally:
        for upload in uploads:
            try:
                await upload.close()
            except Exception:
                pass


@router.get("/jobs/{job_id}")
async def import_job(
    job_id: str,
    _owner: AdminDetails = Depends(_require_owner),
):
    _require_feature()
    job_id = _safe_id(job_id, "job id")
    path = JOBS_DIR / f"{job_id}.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError) as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Backup job was not found") from exc
    if not isinstance(value, dict):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Backup job is invalid")
    return value
