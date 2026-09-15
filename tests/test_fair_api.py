import importlib.util
import sys
import types
from pathlib import Path

import pytest
from fastapi import FastAPI, Header, HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel
from sqlalchemy import Boolean, Column, Integer, JSON, String, create_engine
from sqlalchemy.orm import DeclarativeBase, Session
from sqlalchemy.pool import StaticPool

import hs_fair_runtime
import hs_fair_use
import hs_outbounds
import hs_services as store


@pytest.fixture
def fair_api(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA", tmp_path)

    class Base(DeclarativeBase):
        pass

    class Node(Base):
        __tablename__ = "nodes"
        id = Column(Integer, primary_key=True)
        core_config_id = Column(Integer)

    class CoreConfig(Base):
        __tablename__ = "cores"
        id = Column(Integer, primary_key=True)
        config = Column(JSON)

    class ProxyHost(Base):
        __tablename__ = "hosts"
        id = Column(Integer, primary_key=True)
        inbound_tag = Column(String)
        is_disabled = Column(Boolean, default=False)

    class Group(Base):
        __tablename__ = "groups"
        id = Column(Integer, primary_key=True)
        name = Column(String)
        is_disabled = Column(Boolean, default=False)

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = Session(engine)
    session.add_all([
        CoreConfig(id=1, config={"inbounds": [{"tag": "paid", "protocol": "vless"}]}),
        Node(id=7, core_config_id=1), Node(id=8, core_config_id=1),
        ProxyHost(id=1, inbound_tag="paid"), ProxyHost(id=2, inbound_tag="paid"),
        Group(id=5, name="VIP"),
    ])
    session.commit()

    class DB:
        async def get(self, cls, identity):
            return session.get(cls, identity)
        async def execute(self, statement):
            return session.execute(statement)

    async def get_db():
        yield DB()

    class Admin(BaseModel):
        username: str = "owner"

    async def owner(authorization: str = Header(default="")):
        if authorization != "Bearer owner":
            raise HTTPException(403, "Owner only")
        return Admin()

    appmod = types.ModuleType("app"); appmod.__path__ = []
    monkeypatch.setitem(sys.modules, "app", appmod)
    dbmod = types.ModuleType("app.db"); dbmod.get_db = get_db; dbmod.AsyncSession = object
    monkeypatch.setitem(sys.modules, "app.db", dbmod)
    models = types.ModuleType("app.db.models")
    for name, value in {"Node":Node,"CoreConfig":CoreConfig,"ProxyHost":ProxyHost,"Group":Group}.items():
        setattr(models,name,value)
    monkeypatch.setitem(sys.modules, "app.db.models", models)
    for parent in ("app.models", "app.routers"):
        module=types.ModuleType(parent); module.__path__=[]; monkeypatch.setitem(sys.modules,parent,module)
    adminmod=types.ModuleType("app.models.admin"); adminmod.AdminDetails=Admin; monkeypatch.setitem(sys.modules,"app.models.admin",adminmod)
    auth=types.ModuleType("app.routers.hs_plugin_api"); auth._require_owner=owner; auth._load_state=lambda:{"features":{"fair_use":{"enabled":True}}}; monkeypatch.setitem(sys.modules,"app.routers.hs_plugin_api",auth)
    for name,value in {"hs_services":store,"hs_outbounds":hs_outbounds,"hs_fair_use":hs_fair_use,"hs_fair_runtime":hs_fair_runtime}.items():
        monkeypatch.setitem(sys.modules,"app."+name,value); setattr(appmod,name,value)

    file=Path(__file__).parents[1]/"backend/hs_services_api.py"
    spec=importlib.util.spec_from_file_location("fair_api_module",file)
    module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    app=FastAPI(); app.include_router(module.router)
    yield TestClient(app), session
    session.close(); engine.dispose()


def test_shared_inbound_policy_is_one_setting(fair_api):
    client,_=fair_api; headers={"Authorization":"Bearer owner"}
    one={"threshold_bytes":100_000_000_000,"baseline_mbps":100,"speed_percent":20}
    response=client.put("/api/hs-services/hosts/1/fair-use",json=one,headers=headers)
    assert response.status_code==200, response.text
    assert response.json()["affected_host_ids"]==[1,2]
    saved=store.read("fair-use.json")
    assert saved["1"]==saved["2"] and saved["1"]["speed_percent"]==20
    assert store.read("fair-use-inbounds.json")["paid"]["speed_percent"]==20
    settings=client.get("/api/hs-services/fair-use",headers=headers).json()
    assert settings["policies"]["1"]==settings["policies"]["2"]
    assert settings["shared_hosts"]=={"1":[1,2],"2":[1,2]}
    assert settings["fair_status_hosts"]==[]

    two={"threshold_bytes":150_000_000_000,"baseline_mbps":120,"speed_percent":35}
    response=client.put("/api/hs-services/hosts/2/fair-use",json=two,headers=headers)
    assert response.status_code==200
    saved=store.read("fair-use.json")
    assert saved["1"]==saved["2"] and saved["1"]["threshold_bytes"]==150_000_000_000
    assert store.read("fair-use-inbounds.json")["paid"]["threshold_bytes"]==150_000_000_000

    response=client.delete("/api/hs-services/hosts/1/fair-use",headers=headers)
    assert response.status_code==200 and response.json()["affected_host_ids"]==[1,2]
    assert store.read("fair-use.json")=={}
    assert store.read("fair-use-inbounds.json")=={}



def test_legacy_host_policy_migrates_to_inbound_without_overwrite(fair_api):
    client,_=fair_api;headers={"Authorization":"Bearer owner"}
    legacy={"mode":"threshold","threshold_bytes":80_000_000_000,"baseline_mbps":100.0,"speed_percent":25.0,"fair_limited":True,"usage_basis":"current_cycle"}
    store.write("fair-use.json",{"1":legacy})
    settings=client.get("/api/hs-services/fair-use",headers=headers)
    assert settings.status_code==200
    data=settings.json()
    assert data["policies"]["1"]==data["policies"]["2"]
    assert store.read("fair-use-inbounds.json")["paid"]["threshold_bytes"]==80_000_000_000
    newer=dict(legacy);newer["speed_percent"]=10.0
    store.write("fair-use-inbounds.json",{"paid":newer})
    store.write("fair-use.json",{"1":legacy})
    data=client.get("/api/hs-services/fair-use",headers=headers).json()
    assert data["policies"]["1"]["speed_percent"]==10.0
    assert store.read("fair-use-inbounds.json")["paid"]["speed_percent"]==10.0

def test_group_always_and_threshold_validation(fair_api):
    client,_=fair_api; headers={"Authorization":"Bearer owner"}
    always={"mode":"always","threshold_bytes":0,"baseline_mbps":90,"speed_percent":33}
    response=client.put("/api/hs-services/groups/5/fair-use",json=always,headers=headers)
    assert response.status_code==200, response.text
    assert store.read("fair-use-groups.json")["5"]["mode"]=="always"
    settings=client.get("/api/hs-services/fair-use",headers=headers).json()
    assert settings["group_policies"]["5"]["threshold_bytes"]==0
    assert settings["groups"]==[{"id":5,"name":"VIP"}]

    invalid={"mode":"threshold","threshold_bytes":0,"baseline_mbps":100,"speed_percent":50}
    response=client.put("/api/hs-services/groups/5/fair-use",json=invalid,headers=headers)
    assert response.status_code==422
    response=client.delete("/api/hs-services/groups/5/fair-use",headers=headers)
    assert response.status_code==200 and store.read("fair-use-groups.json")=={}


def test_host_fair_status_is_hs_metadata_not_native_enum(fair_api):
    client,_=fair_api; headers={"Authorization":"Bearer owner"}
    enabled=client.put('/api/hs-services/hosts/1/fair-status',json={'enabled':True},headers=headers)
    assert enabled.status_code==200 and enabled.json()['fair_limited'] is True
    assert store.read('fair-host-status.json')=={'1':True}
    settings=client.get('/api/hs-services/fair-use',headers=headers).json()
    assert settings['fair_status_hosts']==[1]
    disabled=client.put('/api/hs-services/hosts/1/fair-status',json={'enabled':False},headers=headers)
    assert disabled.status_code==200 and store.read('fair-host-status.json')=={}
    missing=client.put('/api/hs-services/hosts/999/fair-status',json={'enabled':True},headers=headers)
    assert missing.status_code==404
