#!/usr/bin/env python3
"""CLI wrapper for :mod:`shared.ensure_ui_dist`."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shared.ensure_ui_dist import ensure_ui_dist_cli

if __name__ == "__main__":
    raise SystemExit(ensure_ui_dist_cli())
