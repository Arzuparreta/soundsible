#!/usr/bin/env python3
"""
Soundsible Launcher — easy entry point.
Starts the launcher web UI and opens the default browser.
"""
import os
import sys
import webbrowser
import threading
import time
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
VENV_DIR = ROOT_DIR / "venv"
VENV_SITE = VENV_DIR / (
    "Lib/site-packages" if sys.platform == "win32" else f"lib/python{sys.version_info.major}.{sys.version_info.minor}/site-packages"
)

def bootstrap():
    if not VENV_DIR.exists():
        print("Creating virtual environment...")
        import subprocess
        subprocess.check_call([sys.executable, "-m", "venv", str(VENV_DIR)])
    if str(VENV_SITE) not in sys.path:
        import site
        site.addsitedir(str(VENV_SITE))


if __name__ == "__main__":
    bootstrap()
    if str(ROOT_DIR) not in sys.path:
        sys.path.insert(0, str(ROOT_DIR))

    from launcher_web.server import start_server, DEFAULT_PORT

    port = int(os.environ.get("LAUNCHER_PORT", DEFAULT_PORT))
    url = f"http://localhost:{port}/"

    def open_browser():
        time.sleep(1.2)
        webbrowser.open(url)

    threading.Thread(target=open_browser, daemon=True).start()
    print(f"Launcher: {url}")
    start_server(port=port)
