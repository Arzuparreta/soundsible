"""Which modules may import which.

`shared/api/__init__.py` is the Flask application, and importing *any* module
in the `shared.api` package runs it first. Services that reached into it for
the download pump, the user cores or the socket — and route modules that
borrowed each other's private helpers — are what made every blueprint defer
its imports to dodge the cycle. These checks keep that from growing back. They
read the source, so imports deferred inside functions count too, and relative
imports are resolved before they are judged.
"""

import ast
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
ROUTES = "shared.api.routes"

#: Starting the engine is the one reason to import the application.
ENTRY_POINTS = {
    "run.py": {"api_observer"},
    "shared/engine_start.py": {"start_api"},
    "shared/container_entrypoint.py": {"start_api"},
    "shared/desktop_engine_entry.py": {"start_api"},
}

#: One blueprint, `discovery_bp`, split across files that share its helpers.
DISCOVERY_FILES = {
    "auto_mode", "discovery", "discovery_bp", "discovery_common",
    "discovery_feed", "discovery_graph", "podcasts_directory",
}


def _sources():
    for base in ("shared", "player", "setup_tool"):
        yield from sorted((ROOT / base).rglob("*.py"))
    yield ROOT / "run.py"
    yield ROOT / "soundsible_engine.py"


def _package_of(rel: str) -> list[str]:
    """The package a relative import in `rel` starts from."""
    parts = rel[:-3].split("/")
    return parts[:-1]  # `pkg/__init__.py` -> pkg, `pkg/mod.py` -> pkg


def _imports(rel: str, tree: ast.AST):
    """`(line, module, name, bound)` for every import, relative ones resolved.

    `bound` is the local name the import creates (its `as` name if any).
    """
    package = _package_of(rel)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield node.lineno, alias.name, None, alias.asname or alias.name.split(".")[0]
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = package[: len(package) - (node.level - 1)]
                module = ".".join(base + ([node.module] if node.module else []))
            else:
                module = node.module or ""
            for alias in node.names:
                yield node.lineno, module, alias.name, alias.asname or alias.name


def _dotted(node: ast.AST) -> str | None:
    """`a.b.c` for an attribute chain on a plain name, else None."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if not isinstance(node, ast.Name):
        return None
    return ".".join([node.id, *reversed(parts)])


def _is_api_package(module, name):
    full = f"{module}.{name}" if name else module
    return any(candidate == "shared.api" or candidate.startswith("shared.api.")
               for candidate in (module, full))


def _application_imports(rel: str, source: str) -> list[str]:
    if rel.startswith("shared/api/"):
        return []
    allowed = ENTRY_POINTS.get(rel, set())
    return [
        f"{rel}:{line} imports {module}{'.' + name if name else ''}"
        for line, module, name, _ in _imports(rel, ast.parse(source))
        if _is_api_package(module, name) and not (module == "shared.api" and name in allowed)
    ]


def _blueprint_of(stem):
    return "discovery" if stem in DISCOVERY_FILES else stem


def _borrowed_privates(rel: str, source: str) -> list[str]:
    """Private names another blueprint's route module is reached for.

    Both spellings count: `from .catalog import _helper` and
    `from . import catalog` followed by `catalog._helper`.
    """
    stem = Path(rel).stem
    tree = ast.parse(source)
    foreign = {}  # local name -> another blueprint's route module
    offenders = []
    for line, module, name, bound in _imports(rel, tree):
        if module == ROUTES and name:
            target, imported = name, None  # from shared.api.routes import catalog [as c]
        elif module.startswith(ROUTES + ".") and name is None:
            target, imported = module.split(".")[3], None  # import shared.api.routes.catalog [as c]
        elif module.startswith(ROUTES + "."):
            target, imported = module.split(".")[3], name  # from shared.api.routes.catalog import x
        else:
            continue
        if _blueprint_of(target) == _blueprint_of(stem):
            continue
        if imported is None:
            # Bare `import shared.api.routes.catalog` binds `shared`; its
            # dotted uses are checked below instead.
            if bound != "shared":
                foreign[bound] = target
        elif imported.startswith("_"):
            offenders.append(f"{rel}:{line} imports {target}.{imported}")
    for node in ast.walk(tree):
        if not isinstance(node, ast.Attribute) or not node.attr.startswith("_"):
            continue
        owner = _dotted(node.value)
        if owner in foreign:
            offenders.append(f"{rel}:{node.lineno} uses {foreign[owner]}.{node.attr}")
        elif owner and owner.startswith(ROUTES + ".") and owner.count(".") == 3:
            target = owner.split(".")[3]
            if _blueprint_of(target) != _blueprint_of(stem):
                offenders.append(f"{rel}:{node.lineno} uses {target}.{node.attr}")
    return offenders


def test_only_entry_points_import_the_application():
    offenders = []
    for path in _sources():
        rel = path.relative_to(ROOT).as_posix()
        offenders += _application_imports(rel, path.read_text(encoding="utf-8"))
    assert offenders == []


def test_blueprints_do_not_borrow_each_others_private_helpers():
    offenders = []
    for path in sorted((ROOT / "shared" / "api" / "routes").glob("*.py")):
        offenders += _borrowed_privates(path.relative_to(ROOT).as_posix(), path.read_text(encoding="utf-8"))
    assert offenders == []


@pytest.mark.parametrize("rel, source", [
    ("shared/loudness/service.py", "from shared.api import socketio"),
    ("shared/loudness/service.py", "def f():\n    import shared.api as api"),
    ("shared/loudness/service.py", "from shared import api"),
    ("shared/library_scan.py", "from .api import app"),
    ("shared/library_scan.py", "from . import api"),
    ("shared/dj/session.py", "from ..api.routes.auto_mode import x"),
    ("run.py", "from shared.api import socketio"),
])
def test_the_application_guard_sees_every_spelling(rel, source):
    assert _application_imports(rel, source)


@pytest.mark.parametrize("source", [
    "from shared.api.routes.catalog import _helper",
    "from .catalog import _helper",
    "from . import catalog\ncatalog._helper()",
    "from shared.api.routes import catalog\ncatalog._helper()",
    "import shared.api.routes.catalog as c\nc._helper()",
    "from . import catalog as c\nc._helper()",
    "from shared.api.routes import catalog as c\nc._helper()",
    "import shared.api.routes.catalog\nshared.api.routes.catalog._helper()",
])
def test_the_blueprint_guard_sees_every_spelling(source):
    assert _borrowed_privates("shared/api/routes/library.py", source)


def test_the_blueprint_guard_allows_one_blueprints_own_files():
    assert _borrowed_privates("shared/api/routes/discovery.py", "from .auto_mode import _helper") == []
