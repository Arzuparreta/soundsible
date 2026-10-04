"""On-device Python probe for the Soundsible Android client.

This module proves the embedded interpreter (Chaquopy) boots and can run
project code on the phone. It is stdlib-only on purpose and is NOT the
Soundsible engine: the engine (`run.py`, Flask/gevent, yt-dlp, FFmpeg,
media scanning) is staged work documented in docs/ANDROID.md.

`runtime_info()` is the contract the Kotlin side calls at startup. Keep its
keys stable; the UI and future engine stages read them.
"""

import platform
import sqlite3


def runtime_info():
    """Describe the interpreter this code is actually running on."""
    return {
        "python_version": platform.python_version(),
        "implementation": platform.python_implementation(),
        "sqlite_version": sqlite3.sqlite_version,
    }
