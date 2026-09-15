"""Remove only identified HS legacy hooks; never replace native files wholesale."""
import argparse
import re
from pathlib import Path

LEGACY_FILES = ('hs-shield.js', 'hs-firewall-charts.js', 'hs-native-extensions.js')


def clean_source(text):
    for start,end in [('hs-shield-router-start','hs-shield-router-end'),('hs-shield-router-register-start','hs-shield-router-register-end'),('hs-ext-router-start','hs-ext-router-end'),('hs-ext-register-start','hs-ext-register-end')]:
        text=re.sub(r'\n?# '+start+r'.*?# '+end+r'\n?', '\n', text, flags=re.S)
    text=text.replace('from app.hs_fair_use_runtime import filter_subscription_hosts\n','').replace('from app.hs_fair_reconcile import reconcile_fair_use\n','')
    text=re.sub(r'(?m)^[ \t]*# hs-fair-use: a Fair-limited user receives only Fair Use eligible Hosts\.\n[ \t]*hosts = filter_subscription_hosts\(hosts, user\)\n','',text)
    text=re.sub(r'(?m)^[ \t]*# hs-fair-use: refresh derived status, Xray marks and node rate plans after charged usage changes\.\n[ \t]*try:\n[ \t]*await reconcile_fair_use\(logger=logger\)\n[ \t]*except Exception:\n[ \t]*logger.exception\("HS Fair Use reconcile failed after usage recording"\)\n','',text)
    return text


def clean_html(text):
    return re.sub(r'<script\b[^>]*(?:hs-shield(?:-loader|\.js)|hs-firewall-charts(?:-loader|\.js)|hs-native-extensions(?:-loader|\.js))[^>]*>\s*</script>\s*','',text,flags=re.I)


def retire(app=None,build=None):
    generated={}
    if app:
        for relative in ('routers/__init__.py','subscription/share.py','jobs/record_usages.py'):
            path=app/relative
            if path.is_file():
                text=clean_source(path.read_text());compile(text,str(path),'exec');generated[path]=text
    if build:
        for name in ('index.html','404.html'):
            path=build/name
            if path.is_file():generated[path]=clean_html(path.read_text())
    for path,text in generated.items():
        if text!=path.read_text():path.write_text(text)
    if build:
        for name in LEGACY_FILES:(build/'statics'/name).unlink(missing_ok=True)
    if app:
        for relative in ('hs_shield_api.py','hs_firewall.py','hs_fair_use_runtime.py','hs_fair_reconcile.py','hs_services_runtime.py','routers/hs_extensions_api.py','routers/hs_shield_api.py'):
            (app/relative).unlink(missing_ok=True)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--app',type=Path);p.add_argument('--build',type=Path);a=p.parse_args();retire(a.app,a.build)
