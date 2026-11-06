#!/usr/bin/env python3
"""
Standalone desktop engine entrypoint.
"""

from __future__ import annotations

import sys


if __name__ == "__main__":
    if sys.argv[1:] == ["--artwork-worker"]:
        from shared.artwork_worker import main

        raise SystemExit(main())
    from shared.dj.worker import FROZEN_FLAG

    # The packaged engine is also its own DJ analysis process: a frozen
    # executable has no `python -m` to start that module with.
    if sys.argv[1:] == [FROZEN_FLAG]:
        from shared.dj.worker import main

        raise SystemExit(main())
    from shared.desktop_engine_entry import run

    raise SystemExit(run(sys.argv[1:]))
