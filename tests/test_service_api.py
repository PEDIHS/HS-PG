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
import hs_fair_runtime


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
        ("hs_fair_runtime", hs_fair_runtime),
    ]:
        monkeypatch.setitem(sys.modules, "app." + name, value)
        setattr(appmod, name, value)

    async def empty_manifest(db,target):return {'revision':'a'*64,'rates':{}}
    monkeypatch.setattr(hs_fair_runtime,'manifest',empty_manifest)

    class Admin(BaseModel):
        username: str = "owner"

    async def owner(authorization: str = Header(default="")):
        if authorization != "Bearer owner":
            raise HTTPException(403, "Owner only")
        return Admin()

    class FakeDB:
        async def get(self, cls, identity):
            return object() if identity == 7 else None

    async def get_db():
        yield FakeDB()

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
    app.state.hs_services_module = module
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
                certificates=[dict(id="example.com", provider="certbot", renewable=True)],
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


def test_one_time_bridge_bootstrap_exchange(api):
    owner = {'Authorization': 'Bearer owner'}
    created = api.post('/api/hs-services/agents/7/bootstrap', headers=owner)
    assert created.status_code == 200
    bootstrap = created.json()['bootstrap_token']
    exchange = api.post('/api/hs-services/agents/7/exchange', json={'bootstrap_token': bootstrap})
    assert exchange.status_code == 200
    token = exchange.json()['token']
    assert store.authenticate('7', token)
    replay = api.post('/api/hs-services/agents/7/exchange', json={'bootstrap_token': bootstrap})
    assert replay.status_code == 401
    missing = api.post('/api/hs-services/agents/8/exchange', json={'bootstrap_token': bootstrap})
    assert missing.status_code == 404


def test_node_bootstrap_rejects_unknown_core(api):
    response = api.post(
        "/api/hs-services/node-bootstrap",
        json={"name":"Poland","address":"poland.example.com","core_id":8},
        headers={"Authorization":"Bearer owner"},
    )
    assert response.status_code == 404


def test_node_self_registration_is_one_time_and_hides_secrets(api, monkeypatch):
    response = api.post(
        "/api/hs-services/node-bootstrap",
        json={"name":"Poland","address":"poland.example.com","core_id":7},
        headers={"Authorization":"Bearer owner"},
    )
    assert response.status_code == 200
    bootstrap = response.json()["bootstrap_token"]
    module = api.app.state.hs_services_module
    class FakeNode:
        id=9; name="Poland"; address="poland.example.com"; port=62050; api_port=62051
    async def fake_register(db, spec, body):
        assert spec["name"] == "Poland"
        assert body.api_key == "11111111-1111-4111-8111-111111111111"
        return FakeNode()
    monkeypatch.setattr(module, "_register_pasarguard_node", fake_register)
    payload={
        "bootstrap_token":bootstrap,
        "api_key":"11111111-1111-4111-8111-111111111111",
        "server_ca":"-----BEGIN CERTIFICATE-----\n" + "A"*80 + "\n-----END CERTIFICATE-----",
    }
    registered = api.post("/api/hs-services/node-register", json=payload)
    assert registered.status_code == 200, registered.text
    data=registered.json()
    assert data["target"] == "9" and store.authenticate("9", data["token"])
    assert payload["api_key"] not in registered.text and payload["server_ca"] not in registered.text
    replay = api.post("/api/hs-services/node-register", json=payload)
    assert replay.status_code == 401


def test_local_node_needs_no_bridge_bootstrap(api):
    import time
    store.write('reports.json', {'7': {
        'updated_at': time.time(),
        'bridge': {'local': True, 'transport': 'local-host'},
        'capabilities': {'local_node': True, 'bridge': True},
    }})
    response=api.post('/api/hs-services/agents/7/bootstrap',headers={'Authorization':'Bearer owner'})
    assert response.status_code==409
    assert 'needs no Bridge install' in response.text


def test_stale_local_report_can_be_reenrolled(api):
    store.write('reports.json', {'7': {
        'updated_at': 0,
        'bridge': {'local': True, 'transport': 'local-host'},
        'capabilities': {'local_node': True, 'bridge': True},
    }})
    response=api.post('/api/hs-services/agents/7/bootstrap',headers={'Authorization':'Bearer owner'})
    assert response.status_code==200
