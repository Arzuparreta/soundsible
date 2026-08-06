#!/usr/bin/env python3
"""Build the AltStore/SideStore source that offers the iOS app.

Soundsible is not on the App Store — guideline 5.2.3 forbids downloading media
from YouTube, which is the thing Soundsible does — so the iPhone app is
installed by sideloading. A "source" is the JSON an AltStore-compatible client
subscribes to; it lists the app and every version it can install.

The source is published as a release asset rather than a page in the website
repo, because ``releases/latest/download/apps.json`` is already a stable URL that
always points at the newest release. One less repository to keep in step.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

BUNDLE_ID = "com.soundsible.player"
REPOSITORY = "Arzuparreta/soundsible"

DESCRIPTION = """\
Your own music streaming server, in your pocket.

Soundsible for iOS is a native client for a Soundsible you run yourself. It \
plays with the screen locked, downloads music for offline listening, and shows \
up properly in the car — title, artist, artwork, a progress bar that tracks, \
and buttons on the wheel that work.

Pair it with your server by scanning the code your Soundsible shows. Your \
library never leaves your own machine.

Requires a running Soundsible server. Nothing here talks to anyone else's \
service.\
"""


def build_source(*, version: str, ipa_bytes: int, released_on: str) -> dict:
    """Return the source document for one released version."""
    download_url = (
        f"https://github.com/{REPOSITORY}/releases/download/v{version}/Soundsible.ipa"
    )
    raw = f"https://raw.githubusercontent.com/{REPOSITORY}/main"

    return {
        "name": "Soundsible",
        "subtitle": "Your own music streaming server. Private, free, and yours.",
        "description": (
            "The official source for the Soundsible iOS app. Soundsible is a "
            "self-hosted music server you run on your own machine."
        ),
        "iconURL": f"{raw}/branding/logo-app.png",
        "website": f"https://github.com/{REPOSITORY}",
        "tintColor": "E0BC00",
        "apps": [
            {
                "name": "Soundsible",
                "bundleIdentifier": BUNDLE_ID,
                "developerName": "Arzuparreta",
                "subtitle": "Play your own music library anywhere.",
                "localizedDescription": DESCRIPTION,
                "iconURL": f"{raw}/branding/logo-app.png",
                "tintColor": "E0BC00",
                "category": "entertainment",
                "screenshots": [],
                "versions": [
                    {
                        "version": version,
                        "buildVersion": "1",
                        "date": released_on,
                        "localizedDescription": (
                            f"Soundsible {version}. See the release notes at "
                            f"https://github.com/{REPOSITORY}/releases/tag/v{version}"
                        ),
                        "downloadURL": download_url,
                        "size": ipa_bytes,
                        "minOSVersion": "26.0",
                    }
                ],
                # Declared so a client can show what the app asks for before it
                # is installed. The camera is only ever used for the pairing QR
                # code; there is no analytics and no third-party network call.
                "appPermissions": {
                    "privacy": [
                        {
                            "name": "Camera",
                            "usageDescription": (
                                "Scanning the pairing QR code your Soundsible shows."
                            ),
                        },
                        {
                            "name": "LocalNetwork",
                            "usageDescription": (
                                "Connecting to the Soundsible server on your own network."
                            ),
                        },
                    ],
                    "entitlements": [],
                },
            }
        ],
        "news": [],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--ipa",
        type=Path,
        required=True,
        help="Path to the built Soundsible.ipa; its size goes into the source.",
    )
    parser.add_argument(
        "--version",
        help="Version being released. Defaults to what shared/version.py declares.",
    )
    parser.add_argument(
        "--date",
        dest="released_on",
        help="Release date as YYYY-MM-DD. Defaults to today.",
    )
    parser.add_argument("--out", type=Path, required=True, help="Where to write apps.json.")
    args = parser.parse_args()

    if not args.ipa.is_file():
        raise SystemExit(f"{args.ipa}: no such file. Build the app first.")

    if args.version:
        version = args.version
    else:
        from scripts.version_sync import declared_version

        version = declared_version()

    source = build_source(
        version=version,
        ipa_bytes=args.ipa.stat().st_size,
        released_on=args.released_on or date.today().isoformat(),
    )
    args.out.write_text(json.dumps(source, indent=2) + "\n", encoding="utf-8")
    print(f"{args.out}: Soundsible {version} ({source['apps'][0]['versions'][0]['size']} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
