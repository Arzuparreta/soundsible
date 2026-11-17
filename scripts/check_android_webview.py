#!/usr/bin/env python3
"""Check the packaged compatibility path before Capacitor copies Android assets."""

from __future__ import annotations

from html.parser import HTMLParser
import json
from pathlib import Path
import re


class StandalonePage(HTMLParser):
    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "script" or tag == "link" and attributes.get("rel") == "stylesheet":
            raise ValueError("The WebView compatibility page must not depend on application JavaScript or stylesheets")


def check(root: Path) -> None:
    config = json.loads((root / "ui_web/capacitor.config.json").read_text())
    target_match = re.search(r"target:\s*['\"]chrome(\d+)['\"]", (root / "ui_web/vite.android.config.ts").read_text())
    sdk_match = re.search(r"minSdkVersion\s*=\s*(\d+)", (root / "android/variables.gradle").read_text())
    if not target_match or not sdk_match:
        raise ValueError("Declare the Android JavaScript target and installation floor explicitly")
    webview = int(config["android"]["minWebViewVersion"])
    if webview < int(target_match[1]):
        raise ValueError("The WebView floor cannot be below the compiled JavaScript target")
    # Chromium 120 dropped Android 7: declaring API 24 would advertise an OS
    # that cannot install the engine required by this application bundle.
    if webview >= 120 and int(sdk_match[1]) < 26:
        raise ValueError("WebView 120 requires at least Android API 26")
    name = config.get("server", {}).get("errorPath")
    if not name:
        raise ValueError("An unsupported WebView needs a packaged errorPath")
    assets = (root / "android/web-dist").resolve()
    fallback = (assets / name).resolve()
    if not fallback.is_relative_to(assets) or not fallback.is_file():
        raise ValueError("The compatibility entry must exist inside the packaged Android assets")
    html = fallback.read_text()
    StandalonePage().feed(html)
    if "<main" not in html or "<h1" not in html:
        raise ValueError("The standalone compatibility page needs an accessible explanation")


if __name__ == "__main__":
    check(Path(__file__).resolve().parents[1])
    print("Packaged Android WebView compatibility entry verified")
