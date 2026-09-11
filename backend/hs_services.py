"""Durable service registry, scoped agent credentials and bounded job queue."""

from __future__ import annotations
import fcntl
import hashlib
import json
import os
import secrets
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

DATA = (
    Path(os.getenv("HS_PLUGIN_DATA_DIR", "/var/lib/pasarguard/hs-plugin")) / "services"
)


def read(name, default=None):
    try:
        return json.loads((DATA / name).read_text())
    except FileNotFoundError:
        return {} if default is None else default


def write(name, value):
    DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(mode="w", dir=DATA, delete=False) as f:
        os.chmod(f.name, 0o600)
        json.dump(value, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(f.name, DATA / name)


@contextmanager
def lock():
    DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (DATA / ".lock").open("a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def enroll(target):
    token = secrets.token_urlsafe(48)
    with lock():
        agents = read("agents.json")
        agents[str(target)] = {
            "token_hash": hashlib.sha256(token.encode()).hexdigest(),
            "created_at": time.time(),
        }
        write("agents.json", agents)
    return token


def authenticate(target, token):
    expected = read("agents.json").get(str(target), {}).get("token_hash", "")
    return bool(expected) and secrets.compare_digest(
        expected, hashlib.sha256(token.encode()).hexdigest()
    )


def enqueue(target, action, resource, payload=None):
    with lock():
        jobs = read("jobs.json", [])
        for job in jobs:
            if (
                job["target"] == str(target)
                and job["resource"] == resource
                and job["state"] in ("queued", "running")
            ):
                return job
        identity = secrets.token_hex(16)
        job = dict(
            id=identity,
            target=str(target),
            action=action,
            resource=resource,
            payload=payload or {},
            state="queued",
            created_at=time.time(),
        )
        jobs = [
            j
            for j in jobs
            if j["state"] in ("queued", "running")
            or j["created_at"] > time.time() - 7 * 86400
        ]
        if len(jobs) >= 1000:
            raise ValueError("Service queue is full")
        jobs.append(job)
        write("jobs.json", jobs)
        return job


def claim(target):
    with lock():
        jobs = read("jobs.json", [])
        for job in jobs:
            if job["state"] == "running" and job.get("lease_until", 0) < time.time():
                # Do not blindly replay a mutation whose response was lost.
                job.update(
                    state="interrupted",
                    error="Agent did not report completion; inspect target before retrying",
                )
        selected = next(
            (j for j in jobs if j["target"] == str(target) and j["state"] == "queued"),
            None,
        )
        if selected:
            selected.update(
                state="running",
                started_at=time.time(),
                lease_until=time.time() + 900,
                lease=secrets.token_hex(16),
            )
        write("jobs.json", jobs)
        return selected


def finish(target, identity, lease, result, error=None):
    with lock():
        jobs = read("jobs.json", [])
        job = next(
            (j for j in jobs if j["id"] == identity and j["target"] == str(target)),
            None,
        )
        completion_hash = hashlib.sha256(lease.encode()).hexdigest()
        if (
            job
            and job["state"] in ("succeeded", "failed")
            and secrets.compare_digest(job.get("completion_hash", ""), completion_hash)
        ):
            return job
        if (
            not job
            or job["state"] not in ("running", "interrupted")
            or not secrets.compare_digest(job.get("lease", ""), lease)
        ):
            raise ValueError("Stale or invalid job lease")
        job.update(
            state="failed" if error else "succeeded",
            result=result,
            error=error,
            completed_at=time.time(),
            completion_hash=completion_hash,
        )
        job.pop("lease", None)
        write("jobs.json", jobs)
        return job
