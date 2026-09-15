"""Exercise the actual eligibility SQL and manifest using an isolated database."""
import asyncio
import sys
import types
import pytest
from sqlalchemy import Boolean, Column, Integer, JSON, String, Table, create_engine
from sqlalchemy.orm import DeclarativeBase, Session
import hs_fair_runtime as fair
import hs_fair_use
import hs_services as store


@pytest.fixture
def database(tmp_path, monkeypatch):
    class Base(DeclarativeBase):
        pass

    definitions = {
        "Node": {"core_config_id": Column(Integer)},
        "CoreConfig": {"config": Column(JSON)},
        "ProxyHost": {"inbound_tag": Column(String), "is_disabled": Column(Boolean, default=False)},
        "User": {"used_traffic": Column(Integer), "status": Column(String)},
        "Group": {"is_disabled": Column(Boolean, default=False)},
        "ProxyInbound": {"tag": Column(String)},
    }
    models = types.ModuleType('app.db.models')
    for name, fields in definitions.items():
        setattr(models, name, type(name, (Base,), {'__tablename__': name, 'id': Column(Integer, primary_key=True), **fields}))
    models.users_groups_association = Table('user_groups', Base.metadata, Column('user_id', Integer), Column('groups_id', Integer))
    models.inbounds_groups_association = Table('inbound_groups', Base.metadata, Column('group_id', Integer), Column('inbound_id', Integer))
    for name in ('app', 'app.db'):
        module = types.ModuleType(name)
        module.__path__ = []
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.setitem(sys.modules, 'app.db.models', models)
    monkeypatch.setitem(sys.modules, 'app.hs_fair_use', hs_fair_use)
    monkeypatch.setattr(store, 'DATA', tmp_path)
    monkeypatch.setattr(fair, 'enabled', lambda: True)
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    session = Session(engine)
    session.add_all([
        models.Node(id=7, core_config_id=1),
        models.CoreConfig(id=1, config={'inbounds': [{'tag': 'paid', 'protocol': 'vless'}]}),
        models.ProxyHost(id=1, inbound_tag='paid'),
        models.ProxyInbound(id=1, tag='paid'),
        models.Group(id=1), models.Group(id=2, is_disabled=True),
        models.User(id=1, status='active', used_traffic=100_000_000_000),
        models.User(id=2, status='active', used_traffic=2_000_000_000),
        models.User(id=3, status='active', used_traffic=200_000_000_000),
        models.User(id=4, status='expired', used_traffic=200_000_000_000),
        models.User(id=5, status='active', used_traffic=200_000_000_000),
    ])
    session.execute(models.users_groups_association.insert(), [{'user_id': i, 'groups_id': 2 if i == 5 else 1} for i in (1, 2, 4, 5)])
    session.execute(models.inbounds_groups_association.insert(), [{'group_id': i, 'inbound_id': 1} for i in (1, 2)])
    session.commit()
    store.write('fair-use.json', {'1': hs_fair_use.validate_policy(dict(threshold_bytes=100_000_000_000, baseline_mbps=100, speed_percent=20))})

    class DB:
        async def get(self, cls, identity):
            return session.get(cls, identity)

        async def execute(self, statement):
            return session.execute(statement)

    yield DB(), session, models
    session.close()
    engine.dispose()


def test_manifest_uses_each_users_traffic_and_group_access(database):
    db, session, models = database
    first = asyncio.run(fair.manifest(db, '7'))
    assert first['rates'] == {'1\0paid': 2_500_000, '2\0paid': 12_500_000}
    assert store.read('fair-runtime.json')['7']['reached'] == {'1': ['i:1:paid']}
    # A reset changes this user's rate, without changing the other user.
    session.get(models.User, 1).used_traffic = 0
    session.commit()
    reset = asyncio.run(fair.manifest(db, '7'))
    assert reset['rates'] == {'1\0paid': 12_500_000, '2\0paid': 12_500_000}
    assert reset['revision'] != first['revision']
    assert store.read('fair-runtime.json')['7']['reached'] == {}



def test_canonical_inbound_policy_covers_new_shared_host(database):
    db,session,models=database
    session.add(models.ProxyHost(id=2,inbound_tag='paid'))
    session.commit()
    store.write('fair-use.json',{})
    store.write('fair-use-inbounds.json',{'paid':hs_fair_use.validate_policy(dict(threshold_bytes=100_000_000_000,baseline_mbps=100,speed_percent=20))})
    result=asyncio.run(fair.manifest(db,'7'))
    assert result['rates']=={'1\0paid':2_500_000,'2\0paid':12_500_000}


def test_manifest_migrates_legacy_policy_without_overwriting_canonical(database):
    db,session,models=database
    asyncio.run(fair.manifest(db,'7'))
    migrated=store.read('fair-use-inbounds.json')
    assert migrated['paid']['speed_percent']==20.0
    newer=hs_fair_use.validate_policy(dict(threshold_bytes=100_000_000_000,baseline_mbps=100,speed_percent=10))
    store.write('fair-use-inbounds.json',{'paid':newer})
    result=asyncio.run(fair.manifest(db,'7'))
    assert result['rates']['1\0paid']==1_250_000
    assert store.read('fair-use-inbounds.json')['paid']['speed_percent']==10.0

def test_same_core_replicated_to_second_node_gets_same_manifest(database):
    db, session, models = database
    session.add(models.Node(id=8, core_config_id=1))
    session.commit()
    first = asyncio.run(fair.manifest(db, '7'))
    second = asyncio.run(fair.manifest(db, '8'))
    expected = {'1\0paid': 2_500_000, '2\0paid': 12_500_000}
    assert first['rates'] == expected
    assert second['rates'] == expected
    assert first['revision'] == second['revision']
    runtime = store.read('fair-runtime.json')
    assert runtime['7']['targets'] == ['7', '8']
    assert runtime['8']['targets'] == ['7', '8']
    assert runtime['7']['reached'] == {'1': ['i:1:paid']}
    assert runtime['8']['reached'] == {'1': ['i:1:paid']}


def test_shared_host_inherits_same_inbound_policy(database):
    db, session, models = database
    session.add(models.ProxyHost(id=2, inbound_tag='paid'))
    session.commit()
    result=asyncio.run(fair.manifest(db,'7'))
    assert result['rates']=={'1\0paid':2_500_000,'2\0paid':12_500_000}
    assert store.read('fair-runtime.json')['7']['source_tags']=={'i:1:paid':['paid']}


def test_same_tag_on_second_core_gets_same_host_policy(database):
    db, session, models = database
    session.add_all([models.CoreConfig(id=2,config={'inbounds':[{'tag':'paid','protocol':'vless'}]}),models.Node(id=8,core_config_id=2)])
    session.commit()
    result=asyncio.run(fair.manifest(db,'8'))
    assert result['rates']=={'1\0paid':2_500_000,'2\0paid':12_500_000}
    assert store.read('fair-runtime.json')['8']['source_tags']=={'i:2:paid':['paid']}


@pytest.mark.parametrize('change',['disabled_host','disabled_feature'])
def test_disabled_host_or_feature_has_no_rate_plan(database,monkeypatch,change):
    db,session,models=database
    if change=='disabled_host':session.get(models.ProxyHost,1).is_disabled=True
    else:monkeypatch.setattr(fair,'enabled',lambda:False)
    session.commit()
    assert asyncio.run(fair.manifest(db,'7'))['rates']=={}


def test_group_always_policy_applies_without_usage_threshold(database):
    db,session,models=database
    core=session.get(models.CoreConfig,1);core.config={'inbounds':[{'tag':'paid','protocol':'vless'},{'tag':'extra','protocol':'vless'}]}
    session.add(models.ProxyInbound(id=2,tag='extra'))
    session.execute(models.inbounds_groups_association.insert(),[{'group_id':1,'inbound_id':2}])
    session.commit()
    store.write('fair-use.json',{})
    store.write('fair-use-groups.json',{'1':hs_fair_use.validate_policy(dict(mode='always',threshold_bytes=0,baseline_mbps=90,speed_percent=33))})
    result=asyncio.run(fair.manifest(db,'7'))
    cap=3_712_500
    assert result['rates']=={'1\0extra':cap,'1\0paid':cap,'2\0extra':cap,'2\0paid':cap}
    runtime=store.read('fair-runtime.json')['7']
    assert runtime['reached']=={'1':['g:1'],'2':['g:1']}
    assert runtime['source_tags']['g:1']==['extra','paid']


def test_host_and_group_overlap_uses_strictest_cap(database):
    db,session,models=database
    store.write('fair-use-groups.json',{'1':hs_fair_use.validate_policy(dict(mode='always',threshold_bytes=0,baseline_mbps=100,speed_percent=10))})
    result=asyncio.run(fair.manifest(db,'7'))
    assert result['rates']['1\0paid']==1_250_000
    assert result['rates']['2\0paid']==1_250_000
    reached=store.read('fair-runtime.json')['7']['reached']
    assert reached['1']==['g:1','i:1:paid'] and reached['2']==['g:1']
