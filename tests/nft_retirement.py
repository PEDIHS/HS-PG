"""Verify upgrade retirement in an isolated network namespace, preserving native rules."""
import os,subprocess,sys,tempfile
from pathlib import Path
if '--child' not in sys.argv:
    subprocess.run(['unshare','--net',sys.executable,__file__,'--child'],check=True)
    raise SystemExit
with tempfile.TemporaryDirectory() as folder:
    root=Path(folder);stub=root/'systemctl';stub.write_text('#!/bin/sh\nexit 0\n');stub.chmod(0o755)
    for table in ('hs_plugin','hs_fair_use','native_keep'):
        subprocess.run(['nft','add','table','inet',table],check=True)
    env={**os.environ,'PATH':str(root)+':'+os.environ['PATH'],'HS_ROOT':str(root/'hs')}
    script=Path(__file__).parents[1]/'plugin/retire-firewall.sh'
    for _ in range(2):subprocess.run(['bash',str(script)],env=env,check=True)
    rules=subprocess.check_output(['nft','list','tables'],text=True)
    assert 'native_keep' in rules and 'hs_plugin' not in rules and 'hs_fair_use' not in rules
print('Upgrade cleanup is idempotent and preserves native firewall tables')
