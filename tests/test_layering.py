"""Which modules may import which.

`shared/api/__init__.py` is the Flask application, and importing *any* module
in the `shared.api` package runs it first. Services that reached into it for
the download pump, the user cores or the socket — and route modules that
borrowed each other's private helpers — are what made every blueprint defer
its imports to dodge the cycle. These checks keep that from growing back. They
read the source, so imports deferred inside functions count too.
"""

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

#: Starting the engine is the one reason to import the application.
ENTRY_POINTS = {
    "run.py": {"start_api", "api_observer"},
    "shared/container_entrypoint.py": {"start_api"},
    "shared/desktop_engine_entry.py": {"start_api"},
}


def _sources():
    for base in ("shared", "player", "setup_tool"):
        yield from sorted((ROOT / base).rglob("*.py"))
    yield ROOT / "run.py"
    yield ROOT / "soundsible_engine.py"


def _imports(path):
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield node.lineno, alias.name, None
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            for alias in node.names:
                yield node.lineno, node.module, alias.name


def _is_api_package(module, name):
    return module == "shared.api" or module.startswith("shared.api.") or (module == "shared" and name == "api")


def test_only_entry_points_import_the_application():
    offenders = []
    for path in _sources():
        rel = path.relative_to(ROOT).as_posix()
        if rel.startswith("shared/api/"):
            continue
        allowed = ENTRY_POINTS.get(rel, set())
        for line, module, name in _imports(path):
            if _is_api_package(module, name) and not (module == "shared.api" and name in allowed):
                offenders.append(f"{rel}:{line} imports {module}{'.' + name if name else ''}")
    assert offenders == []


#: One blueprint, `discovery_bp`, split across files that share its helpers.
DISCOVERY_FILES = {
    "auto_mode", "discovery", "discovery_bp", "discovery_common",
    "discovery_feed", "discovery_graph", "podcasts_directory",
}


def _blueprint_of(stem):
    return "discovery" if stem in DISCOVERY_FILES else stem


def test_blueprints_do_not_borrow_each_others_private_helpers():
    offenders = []
    for path in sorted((ROOT / "shared" / "api" / "routes").glob("*.py")):
        own = f"shared.api.routes.{path.stem}"
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom):
                continue
            module = node.module or ""
            if node.level:
                module = f"shared.api.routes.{module}"
            if not module.startswith("shared.api.routes.") or module == own:
                continue
            if _blueprint_of(module.rsplit(".", 1)[1]) == _blueprint_of(path.stem):
                continue
            for alias in node.names:
                if alias.name.startswith("_"):
                    offenders.append(f"{path.name}:{node.lineno} imports {module}.{alias.name}")
    assert offenders == []
