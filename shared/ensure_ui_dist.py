"""Keep ``ui_web/dist`` in sync with the SolidJS source tree.

The Station engine serves the Vite production bundle, not TypeScript source.
Call :func:`ensure_ui_dist` on API boot and before serving ``/player`` so a
stale or missing ``dist/`` is rebuilt automatically when Node is available.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Iterable, Optional

logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_UI_WEB = _REPO_ROOT / "ui_web"
_INPUT_FILES = (
    "index.html",
    "package.json",
    "package-lock.json",
    "vite.config.js",
    "tsconfig.json",
    "vitest.config.ts",
)
_LOCK = threading.Lock()


def _truthy_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def _iter_input_files(ui_web: Path) -> Iterable[Path]:
    for name in _INPUT_FILES:
        path = ui_web / name
        if path.is_file():
            yield path
    src = ui_web / "src"
    if not src.is_dir():
        return
    for path in src.rglob("*"):
        if path.is_file():
            yield path


def ui_dist_is_stale(ui_web: Path | None = None) -> bool:
    """True when ``dist/index.html`` is missing or older than UI sources."""
    root = ui_web or _DEFAULT_UI_WEB
    dist_index = root / "dist" / "index.html"
    if not dist_index.is_file():
        return True
    try:
        dist_mtime = dist_index.stat().st_mtime
    except OSError:
        return True
    for path in _iter_input_files(root):
        try:
            if path.stat().st_mtime > dist_mtime:
                return True
        except OSError:
            continue
    return False


def ensure_ui_dist(
    *,
    ui_web: Path | None = None,
    external_dist: Path | None = None,
    skip_external_dist: bool = True,
    force: bool = False,
) -> bool:
    """Rebuild ``ui_web/dist`` when missing/stale.

    Returns True when a usable ``dist/index.html`` exists afterwards.
    Never raises — build failures are logged so the engine can still start
    with an older bundle (or fall back to the Vite source shell).
    """
    if _truthy_env("SOUNDSIBLE_SKIP_UI_BUILD"):
        root = ui_web or _DEFAULT_UI_WEB
        return (root / "dist" / "index.html").is_file()

    if skip_external_dist:
        external = external_dist
        if external is None:
            env_dist = os.environ.get("SOUNDSIBLE_UI_DIST", "").strip()
            external = Path(env_dist) if env_dist else None
        if external is not None:
            # Desktop/sidecar serves a bundled tree; do not rebuild repo sources.
            return True

    root = (ui_web or _DEFAULT_UI_WEB).resolve()
    dist_index = root / "dist" / "index.html"

    with _LOCK:
        if not force and not ui_dist_is_stale(root):
            return True

        npm = shutil.which("npm")
        if not npm:
            if dist_index.is_file():
                logger.warning(
                    "ui_web/dist is stale (or missing inputs changed) but npm was not found; serving existing bundle"
                )
                return True
            logger.error("ui_web/dist is missing and npm was not found; cannot build the web player")
            return False

        if not (root / "node_modules").is_dir():
            if dist_index.is_file():
                logger.warning(
                    "ui_web/node_modules missing; cannot rebuild. Serving existing ui_web/dist"
                )
                return True
            logger.error(
                "ui_web/dist and node_modules are missing. Run: cd ui_web && npm ci && npm run build"
            )
            return False

        logger.info("Rebuilding ui_web/dist (source newer than bundle)…")
        try:
            # Vite only — typecheck stays in ``npm test`` / ``npm run build``.
            result = subprocess.run(
                [npm, "exec", "--", "vite", "build"],
                cwd=str(root),
                capture_output=True,
                text=True,
                check=False,
            )
        except OSError as exc:
            logger.error("Failed to run vite build: %s", exc)
            return dist_index.is_file()

        if result.returncode != 0:
            tail = (result.stderr or result.stdout or "").strip()
            if len(tail) > 2000:
                tail = tail[-2000:]
            logger.error("ui_web vite build failed (exit %s):\n%s", result.returncode, tail)
            return dist_index.is_file()

        if not dist_index.is_file():
            logger.error("ui_web vite build finished but dist/index.html is still missing")
            return False

        logger.info("ui_web/dist rebuilt successfully")
        return True


def ensure_ui_dist_cli(argv: Optional[list[str]] = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Rebuild ui_web/dist when source is newer.")
    parser.add_argument("--force", action="store_true", help="Rebuild even if dist looks current.")
    parser.add_argument(
        "--ui-web",
        type=Path,
        default=None,
        help="Path to the ui_web directory (default: repo ui_web/).",
    )
    args = parser.parse_args(argv)
    ok = ensure_ui_dist(ui_web=args.ui_web, skip_external_dist=False, force=args.force)
    return 0 if ok else 1
