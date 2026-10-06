#!/usr/bin/env python3
"""Android parity inventory: i18n keys the web UI reaches and the Android UI never does.

Follows relative imports from ui_web/src/main.tsx and ui_web/src/mobile/main.tsx and
lists, per web-only file, the `t('...')` keys it uses that no Android-reachable file
uses. A hit is a candidate missing function, not a verdict: layout/shell files and
keys built dynamically (t(cond ? 'a' : 'b')) need a human look.

Usage: python3 scripts/android_parity_inventory.py
"""
import re
from pathlib import Path
root = (Path(__file__).resolve().parent.parent / 'ui_web' / 'src')
imp = re.compile(r"""(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^import\s+['"]([^'"]+)['"]""", re.M)
def resolve(base, spec):
    if not spec.startswith('.'): return None
    p = (base.parent / spec).resolve()
    for cand in [p, p.with_suffix('.ts'), p.with_suffix('.tsx'), p / 'index.ts', p / 'index.tsx']:
        if cand.is_file() and cand.suffix in ('.ts', '.tsx'): return cand
    for ext in ('.ts', '.tsx'):
        c = Path(str(p) + ext)
        if c.is_file(): return c
    return None
def reach(entry):
    seen, stack = set(), [root / entry]
    while stack:
        f = stack.pop()
        if f in seen: continue
        seen.add(f)
        for m in imp.finditer(f.read_text()):
            spec = next(g for g in m.groups() if g)
            r = resolve(f, spec)
            if r and '.test.' not in r.name: stack.append(r)
    return seen
web, android = reach('main.tsx'), reach('mobile/main.tsx')
key = re.compile(r"""\bt\(\s*['"]([a-zA-Z0-9_.]+)['"]""")
def keys(files):
    out = {}
    for f in files:
        for k in key.findall(f.read_text()): out.setdefault(k, set()).add(str(f.relative_to(root)))
    return out
wk, ak = keys(web - android), keys(android)
only = {k: sorted(v) for k, v in wk.items() if k not in ak}
by_file = {}
for k, fs in only.items():
    for f in fs: by_file.setdefault(f, []).append(k)
print(len(web), len(android), len(web - android), len(only))
for f in sorted(by_file, key=lambda f: -len(by_file[f])):
    print(f"{len(by_file[f]):4d} {f}: {' '.join(sorted(by_file[f])[:12])}")
