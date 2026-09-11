#!/usr/bin/env python3
"""Idempotently register HS Services API without Shield."""
from __future__ import annotations
import argparse, ast, re
from pathlib import Path

IMPORT_START = "# hs-services-router-start"
IMPORT_END = "# hs-services-router-end"
REGISTER_START = "# hs-services-router-register-start"
REGISTER_END = "# hs-services-router-register-end"
LEGACY = [("# hs-shield-router-start", "# hs-shield-router-end"), ("# hs-shield-router-register-start", "# hs-shield-router-register-end")]

def strip(text,start,end):
    return re.sub(rf"\n?{re.escape(start)}.*?{re.escape(end)}\n?", "", text, flags=re.S)

def routers_end(text):
    tree=ast.parse(text)
    for node in tree.body:
        if isinstance(node,(ast.Assign,ast.AnnAssign)):
            targets=node.targets if isinstance(node,ast.Assign) else [node.target]
            if any(isinstance(t,ast.Name) and t.id=="routers" for t in targets):
                lines=text.splitlines(keepends=True)
                return sum(len(x) for x in lines[:node.end_lineno])
    raise RuntimeError("routers assignment not found")

def patch(text):
    for a,b in LEGACY+[(IMPORT_START,IMPORT_END),(REGISTER_START,REGISTER_END)]: text=strip(text,a,b)
    block=f'''{IMPORT_START}\ntry:\n    from app import hs_services_api\nexcept Exception:\n    import logging\n    logging.getLogger(__name__).exception('HS Services router import failed')\n    hs_services_api = None\n{IMPORT_END}\n\n'''
    text=text.replace("api_router = APIRouter()",block+"api_router = APIRouter()",1)
    pos=routers_end(text)
    reg=f'''\n{REGISTER_START}\nif hs_services_api is not None:\n    routers.insert(0, hs_services_api.router)\n{REGISTER_END}\n'''
    out=text[:pos]+reg+text[pos:]; ast.parse(out); return out

def main():
    p=argparse.ArgumentParser(); p.add_argument("--app-root",required=True); p.add_argument("--services-api",required=True); a=p.parse_args()
    app=Path(a.app_root); router=app/"routers"/"__init__.py"; src=Path(a.services_api)
    target=app/"hs_services_api.py"; target.write_text(src.read_text(),encoding="utf-8")
    for name in ("hs_services.py","hs_outbounds.py","hs_fair_use.py"):
        s=src.parent/name
        if s.exists(): (app/name).write_text(s.read_text(),encoding="utf-8")
    router.write_text(patch(router.read_text(encoding="utf-8")),encoding="utf-8")
if __name__=="__main__": main()
