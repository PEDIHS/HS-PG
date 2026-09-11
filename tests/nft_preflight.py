"""Run on Linux with CAP_NET_ADMIN in an isolated network namespace (CI)."""
import subprocess
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parents[1] / 'backend'))
from hs_firewall import render_policy
policy = dict(management_ports=[22], syn_ports=[443], syn_rate=100, rules=[
    dict(id='v4', source='192.0.2.0/24', action='block', protocol='tcp', port=443),
    dict(id='v6', source='2001:db8::/32', action='allow', protocol='any')])
for elevated in (False, True):
    script = render_policy(policy, elevated=elevated)
    subprocess.run(['unshare', '--net', 'nft', '--check', '-f', '-'], input=script, text=True, check=True)
print('nftables preflight passed in isolated namespaces')
