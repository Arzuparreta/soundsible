#!/usr/bin/env python3
"""
Standalone desktop engine entrypoint.
"""

from __future__ import annotations

import sys

from run import run_desktop_engine_cli


if __name__ == "__main__":
    raise SystemExit(run_desktop_engine_cli(sys.argv[1:]))
