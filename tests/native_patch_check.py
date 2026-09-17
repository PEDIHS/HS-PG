import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[1]/'plugin'))
from patch_services_api import patch_native,patch_router
app=Path(sys.argv[1])
generated=patch_native(app)
generated[app/'routers/__init__.py']=patch_router((app/'routers/__init__.py').read_text())
for p,text in generated.items():compile(text,str(p),'exec');p.write_text(text)
assert 'def hs_fair_configured(self) -> bool:' in generated[app/'models/user.py']
assert 'configured_user_ids' in generated[app/'db/crud/user.py']
assert 'filters.append(or_(manual, enforced))' in generated[app/'db/crud/user.py']
assert patch_native(app)=={p:text for p,text in generated.items() if p!=app/'routers/__init__.py'}
assert patch_router(generated[app/'routers/__init__.py'])==generated[app/'routers/__init__.py']
print('Native subscription, derived status, filters, migration and router hooks compile and are idempotent')
