"""Load trusted DJ code from Git for probes, before or after the P11 split.

Only the DJ implementation is isolated; runtime/FFmpeg and numerical libraries
are the current ones, so comparisons use the same environment. No cache is read.
"""

from __future__ import annotations

import importlib
import importlib.util
import subprocess
import sys
import tempfile
import types
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load_reference(revision: str):
    def read(path):
        return subprocess.check_output(['git', 'show', f'{revision}:{path}'], cwd=ROOT, text=True)

    source = read('shared/dj_engine.py')
    if 'def _compose(' in source:
        module = types.ModuleType('reference_dj_engine')
        exec(compile(source, f'{revision}:shared/dj_engine.py', 'exec'), module.__dict__)
        return module

    # Use a separate package namespace: executing the facade would import the
    # current shared.dj implementation and falsely report reference equality.
    name = f'_dj_reference_{uuid.uuid4().hex}'
    files = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', revision, '--', 'shared/dj'],
                                    cwd=ROOT, text=True).splitlines()
    with tempfile.TemporaryDirectory(prefix='dj-reference-') as temporary:
        root = Path(temporary)
        for path in files:
            relative = Path(path).relative_to('shared/dj')
            if len(relative.parts) != 1 or relative.suffix != '.py':
                continue
            (root / relative).write_text(read(path))
        spec = importlib.util.spec_from_file_location(name, root / '__init__.py', submodule_search_locations=[str(root)])
        package = importlib.util.module_from_spec(spec)
        sys.modules[name] = package
        spec.loader.exec_module(package)
        features = importlib.import_module(f'{name}.features')
        store = importlib.import_module(f'{name}.store')
        analysis = importlib.import_module(f'{name}.analysis')
        routes = importlib.import_module(f'{name}.routes')
        transitions = importlib.import_module(f'{name}.transitions')
        return types.SimpleNamespace(
            _KEY_NAMES=features._KEY_NAMES, _window_features=features._window_features,
            _analyse_pcm=store._analyse_pcm, _compose=analysis._compose, _compose_off_loop=store._compose_off_loop,
            plan_transition=transitions.plan_transition,
            order_continuous_route=routes.order_continuous_route,
            order_route=routes.order_route, route_to_request=routes.route_to_request,
        )
