#!/usr/bin/env python3
"""
Standalone desktop engine entrypoint.
"""

from __future__ import annotations

import sys

from shared.desktop_engine_entry import run


if __name__ == "__main__":
    raise SystemExit(run(sys.argv[1:]))
