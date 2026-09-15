"""Fail-closed additive dispatcher adapter for an explicitly selected Xray source."""
from pathlib import Path
import sys,shutil

def patch(text):
    anchor='func (d *DefaultDispatcher) routedDispatch(ctx context.Context, link *transport.Link, destination net.Destination) {'
    if text.count(anchor)!=1:raise ValueError('Unsupported Xray dispatcher')
    if 'hsfair.Wrap(ctx, link)' in text:return text
    if '"context"' not in text:raise ValueError('Unsupported Xray imports')
    return text.replace('"context"','"context"\n "github.com/xtls/xray-core/common/hsfair"',1).replace(anchor,anchor+'\n hsfair.Wrap(ctx, link)',1)
if __name__=='__main__':
    source=Path(sys.argv[1]);addon=Path(sys.argv[2]);p=source/'app/dispatcher/default.go';text=patch(p.read_text());shutil.copytree(addon,source/'common/hsfair',dirs_exist_ok=True);p.write_text(text)
