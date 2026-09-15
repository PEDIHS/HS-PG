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
    assert store.read('fair-runtime.json')['7']['reached'] == {'1': ['1']}
    # A reset changes this user's rate, without changing the other user.
    session.get(models.User, 1).used_traffic = 0
    session.commit()
    reset = asyncio.run(fair.manifest(db, '7'))
    assert reset['rates'] == {'1\0paid': 12_500_000, '2\0paid': 12_500_000}
    assert reset['revision'] != first['revision']
    assert store.read('fair-runtime.json')['7']['reached'] == {}


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
    assert runtime['7']['reached'] == {'1': ['1']}
    assert runtime['8']['reached'] == {'1': ['1']}


@pytest.mark.parametrize('change', ['second_host', 'second_core', 'disabled_host', 'disabled_feature'])
def test_no_accidental_limit_on_other_host_or_core(database, monkeypatch, change):
    db, session, models = database
    if change == 'second_host':
        session.add(models.ProxyHost(id=2, inbound_tag='paid'))
    elif change == 'second_core':
        session.add(models.CoreConfig(id=2, config={'inbounds': [{'tag': 'paid', 'protocol': 'vless'}]}))
    elif change == 'disabled_host':
        session.get(models.ProxyHost, 1).is_disabled = True
    else:
        monkeypatch.setattr(fair, 'enabled', lambda: False)
    session.commit()
    assert asyncio.run(fair.manifest(db, '7'))['rates'] == {}
