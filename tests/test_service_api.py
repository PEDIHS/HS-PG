import importlib.util
import sys
import types
from pathlib import Path
import pytest
from fastapi import FastAPI, Header, HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel
import hs_services as store
import hs_outbounds
import hs_fair_use
import hs_firewall


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA", tmp_path)
    appmod = types.ModuleType("app")
    appmod.__path__ = []
    monkeypatch.setitem(sys.modules, "app", appmod)
    for name in [
        "app.db",
        "app.db.models",
        "app.models",
        "app.models.admin",
        "app.routers",
        "app.routers.authentication",
        "app.routers.hs_plugin_api",
    ]:
        module = types.ModuleType(name)
        monkeypatch.setitem(sys.modules, name, module)
    for name, value in [
        ("hs_services", store),
        ("hs_outbounds", hs_outbounds),
        ("hs_fair_use", hs_fair_use),
        ("hs_firewall", hs_firewall),
    ]:
        monkeypatch.setitem(sys.modules, "app." + name, value)
        setattr(appmod, name, value)

    class Admin(BaseModel):
        username: str = "owner"

    async def owner(authorization: str = Header(default="")):
        if authorization != "Bearer owner":
            raise HTTPException(403, "Owner only")
        return Admin()

    async def get_db():
        yield None

    db = sys.modules["app.db"]
    db.get_db = get_db
    db.AsyncSession = object
    models = sys.modules["app.db.models"]
    models.Node = object
    models.CoreConfig = object
    sys.modules["app.models.admin"].AdminDetails = Admin
    auth = sys.modules["app.routers.hs_plugin_api"]
    auth._require_owner = owner
    auth._load_state = lambda: {
        "features": {
            "certificate_manager": {"enabled": True},
            "mtproxy": {"enabled": True},
        }
    }
    file = Path(__file__).parents[1] / "backend/hs_services_api.py"
    spec = importlib.util.spec_from_file_location("service_test_api", file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    app = FastAPI()
    app.include_router(module.router)
    return TestClient(app)


def test_agent_cannot_call_owner_routes(api):
    token = store.enroll("7")
    assert (
        api.get(
            "/api/hs-services/inventory", headers={"Authorization": "Bearer " + token}
        ).status_code
        == 403
    )
    assert (
        api.post(
            "/api/hs-services/targets/panel/renew",
            json={"certificate_id": "x"},
            headers={"Authorization": "Bearer " + token},
        ).status_code
        == 403
    )


def test_poll_claim_completion_cross_target(api):
    token = store.enroll("7")
    headers = {"Authorization": "Bearer " + token}
    original = store.enqueue("7", "renew", "example.com")
    result = api.post(
        "/api/hs-services/agents/7/poll", json={"certificates": []}, headers=headers
    )
    assert result.status_code == 200, result.text
    job = result.json()["job"]
    assert job["id"] == original["id"]
    assert (
        api.post("/api/hs-services/agents/8/poll", json={}, headers=headers).status_code
        == 401
    )
    done = api.post(
        "/api/hs-services/agents/7/complete",
        json={"id": job["id"], "lease": job["lease"], "result": {"ok": True}},
        headers=headers,
    )
    assert done.status_code == 200 and done.json()["state"] == "succeeded"
    assert "lease" not in done.json() and "payload" not in done.json()


def test_offline_target_rejects_renewal(api):
    response = api.post(
        "/api/hs-services/targets/panel/renew",
        json={"certificate_id": "x"},
        headers={"Authorization": "Bearer owner"},
    )
    assert response.status_code == 409


def test_renewal_deduplicates_and_hides_payload(api):
    import time

    store.write(
        "reports.json",
        {
            "panel": dict(
                updated_at=time.time(),
                certificates=[dict(id="example.com", renewable=True)],
            )
        },
    )
    one = api.post(
        "/api/hs-services/targets/panel/renew",
        json={"certificate_id": "example.com"},
        headers={"Authorization": "Bearer owner"},
    )
    two = api.post(
        "/api/hs-services/targets/panel/renew",
        json={"certificate_id": "example.com"},
        headers={"Authorization": "Bearer owner"},
    )
    assert one.status_code == 200 and one.json()["id"] == two.json()["id"]
