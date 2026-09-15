from pathlib import Path
from types import SimpleNamespace as Obj
import time
import pytest
import hs_services as store
import hs_fair_runtime as fair
from retire_legacy import clean_source, clean_html
from patch_services_api import patch_router

@pytest.fixture
def runtime(tmp_path,monkeypatch):
    monkeypatch.setattr(store,'DATA',tmp_path)
    monkeypatch.setattr(fair,'enabled',lambda:True)
    from hs_fair_use import validate_policy
    p=validate_policy({'threshold_bytes':100_000_000_000,'speed_percent':20.,'baseline_mbps':100.})
    store.write('fair-use.json',{'1':p});store.write('fair-use-groups.json',{})
    source='i:1:a';digest=fair._policy_digest()
    store.write('fair-runtime.json',{'7':{'revision':'a'*64,'policy_digest':digest,'targets':['7'],'users':{'1':[source],'2':[source]},'reached':{'1':[source]},'policies':{source:p},'source_tags':{source:['a']}}})
    store.write('reports.json',{'7':{'updated_at':time.time(),'fair_use':{'adapter':'hs-rate-v1','updated_at':time.time(),'revision':'a'*64}}})
    return p

def test_no_shared_user_counter_and_ack_gate(runtime):
    one=Obj(id=1,status='active',used_traffic=100_000_000_000)
    two=Obj(id=2,status='active',used_traffic=5_000_000_000)
    assert fair.user_state(one)['status']=='fair_limited'
    assert fair.user_state(two) is None
    two.used_traffic=100_000_000_000
    assert fair.user_state(two)['pending'] # Consumption crossed, core has not applied yet.
    store.write('reports.json',{})
    assert fair.user_state(one)['pending']


def test_replicated_core_waits_for_missing_runtime_and_every_ack(runtime):
    state=store.read('fair-runtime.json')
    state['7']['targets']=['7','8']
    store.write('fair-runtime.json',state)
    user=Obj(id=1,status='active',used_traffic=100_000_000_000)
    # Target 8 has not even polled yet: target 7 must not make the user look enforced.
    assert fair.user_state(user)['pending']
    assert fair.limited_groups()=={}
    state=store.read('fair-runtime.json')
    state['8']={'revision':'a'*64,'policy_digest':state['7']['policy_digest'],'targets':['7','8'],'users':{'1':['i:1:a']},'reached':{'1':['i:1:a']},'policies':{'i:1:a':runtime},'source_tags':{'i:1:a':['a']}}
    store.write('fair-runtime.json',state)
    # Target 8 has a manifest but has not acknowledged it yet.
    assert fair.user_state(user)['pending']
    reports=store.read('reports.json')
    reports['8']={'updated_at':time.time(),'fair_use':{'adapter':'hs-rate-v1','updated_at':time.time(),'revision':'a'*64}}
    store.write('reports.json',reports)
    assert fair.user_state(user)['status']=='fair_limited'
    assert fair.limited_groups()=={100_000_000_000:{1}}

@pytest.mark.parametrize('status',['limited','expired','disabled','on_hold'])
def test_native_precedence(runtime,status):
    assert fair.user_state(Obj(id=1,status=status,used_traffic=200_000_000_000)) is None

def test_host_identity_filter_and_reset(runtime):
    hosts={1:Obj(inbound_tag='a',status=[]),2:Obj(inbound_tag='a',status=[]),3:Obj(inbound_tag='b',status=[])}
    user=Obj(id=1,status='active',used_traffic=100_000_000_000,inbounds=['a','b'])
    assert fair.filter_hosts(hosts,user)==[hosts[1],hosts[2]]
    user.used_traffic=0
    assert fair.filter_hosts(hosts,user)==list(hosts.values())
    assert fair.limited_groups()=={100_000_000_000:{1}}


def test_always_group_policy_limits_all_group_inbounds(runtime):
    from hs_fair_use import validate_policy
    p=validate_policy({'mode':'always','threshold_bytes':0,'baseline_mbps':90,'speed_percent':33})
    store.write('fair-use.json',{});store.write('fair-use-groups.json',{'5':p})
    digest=fair._policy_digest();source='g:5'
    store.write('fair-runtime.json',{'7':{'revision':'b'*64,'policy_digest':digest,'targets':['7'],'users':{'1':[source]},'reached':{'1':[source]},'policies':{source:p},'source_tags':{source:['a','b']}}})
    store.write('reports.json',{'7':{'updated_at':time.time(),'fair_use':{'adapter':'hs-rate-v1','updated_at':time.time(),'revision':'b'*64}}})
    user=Obj(id=1,status='active',used_traffic=0,inbounds=['a','b'])
    state=fair.user_state(user)
    assert state['status']=='fair_limited' and state['inbound_tags']==['a','b']
    hosts={1:Obj(inbound_tag='a',status=[]),2:Obj(inbound_tag='b',status=[]),3:Obj(inbound_tag='c',status=[])}
    assert fair.filter_hosts(hosts,user)==[hosts[1],hosts[2]]
    assert fair.limited_groups()=={0:{1}}

def test_changed_policy_waits_for_core(runtime):
    runtime['speed_percent']=10
    store.write('fair-use.json',{'1':runtime})
    assert fair.user_state(Obj(id=1,status='active',used_traffic=100_000_000_000))['pending']
    assert fair.limited_groups()=={}

def test_retirement_preserves_native_and_new_service_routes():
    native='from fastapi import APIRouter\napi_router = APIRouter()\nrouters = []\n'
    old=native+'# hs-shield-router-start\nfrom app import hs_shield_api\n# hs-shield-router-end\n'
    clean=clean_source(old)
    assert 'hs_shield_api' not in clean and 'api_router' in clean
    patched=patch_router(clean)
    assert patch_router(patched)==patched
    assert clean_source(patched)==patched
    assert clean_html('<body><script src="/app.js"></script><script id="hs-shield-loader" src="/statics/hs-shield.js"></script></body>')=='<body><script src="/app.js"></script></body>'

def test_legacy_rate_routes_only_are_removed():
    bad={'tag':'hs-fair-1-0123456789','protocol':'freedom','settings':{},'streamSettings':{'sockopt':{'mark':0x48000001}}}
    user={'tag':'hs-fair-custom','protocol':'socks','settings':{}}
    config={'outbounds':[bad,user,{'tag':'warp','protocol':'wireguard'}],'routing':{'rules':[{'outboundTag':bad['tag']},{'outboundTag':'warp'}]}}
    fixed=fair.strip_legacy_routes(config)
    assert len(fixed['outbounds'])==2 and fixed['routing']['rules']==[{'outboundTag':'warp'}]
    assert config['outbounds'][0]==bad
