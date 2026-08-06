#!/usr/bin/env python3
"""Report what is still missing before Soundsible can ship on AltStore PAL.

The iOS app is distributed by sideloading, which costs nothing and works
everywhere but makes the installing person re-sign it every seven days.
**AltStore PAL** removes that: installs are permanent, there is no three-app
cap, and the marketplace itself installs from Safari, so the user never needs a
computer. It costs an Apple Developer Program membership, and Apple's
Notarization for EU marketplaces reviews security rather than content, so the
app ships whole.

The decision to pay is not this script's business. Its job is to make the day
you *do* pay short: run it and it tells you, in order, which of the steps are
done and which one is next.

Nothing here talks to Apple. Membership, the EU terms addendum and the
Notarization submission all happen in a browser and leave no trace this can
read, so those are declared by hand with `--confirm`. Everything that lives in
this repository's configuration is detected.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from dataclasses import dataclass, field

# Secrets the release workflow needs to build a signed archive and hand it to
# App Store Connect. Names only ever leave `gh`; values are never read.
REQUIRED_SECRETS = {
    "APPLE_DISTRIBUTION_CERTIFICATE_P12": (
        "Base64 of the Apple Distribution certificate exported as .p12"
    ),
    "APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD": "Password for that .p12",
    "APPLE_PROVISIONING_PROFILE": (
        "Base64 of the provisioning profile for com.soundsible.player"
    ),
    "APP_STORE_CONNECT_KEY_ID": "Key ID of the App Store Connect API key",
    "APP_STORE_CONNECT_ISSUER_ID": "Issuer ID of that key",
    "APP_STORE_CONNECT_PRIVATE_KEY": "Base64 of the .p8 private key",
}

REQUIRED_VARIABLES = {
    "APPLE_TEAM_ID": "Ten-character team identifier from the developer portal",
    "SOUNDSIBLE_MARKETPLACE_ID": (
        "Marketplace identifier Apple assigns once the app is registered for "
        "alternative distribution"
    ),
    "SOUNDSIBLE_ADP_BASE_URL": (
        "Where the Alternative Distribution Package is hosted, directory "
        "structure and hashes preserved"
    ),
}

# Steps that happen in a browser and leave nothing this can inspect.
MANUAL_STEPS = {
    "membership": "Apple Developer Program membership is active (99 EUR/year)",
    "eu-terms": "Alternative Terms Addendum for Apps in the EU is accepted",
    "pal-registered": (
        "Developer ID registered with AltStore PAL, and its security token "
        "added under App Store Connect > Users and Access > Integrations > "
        "Marketplace"
    ),
    "notarized": (
        "App Review type set to Notarization in App Store Connect and the "
        "build accepted, which generates the Alternative Distribution Package"
    ),
}

STATE_FILE = "altstore-pal-state.json"


@dataclass
class Check:
    key: str
    description: str
    done: bool
    hint: str = ""


@dataclass
class Report:
    checks: list[Check] = field(default_factory=list)

    @property
    def remaining(self) -> list[Check]:
        return [check for check in self.checks if not check.done]

    @property
    def ready(self) -> bool:
        return not self.remaining


def gh_names(kind: str, repo: str | None) -> set[str] | None:
    """Names of the repository's secrets or variables, or None if unknown.

    `gh` prints names and never values, which is the only thing worth checking:
    whether a credential is present, not what it is.
    """
    if shutil.which("gh") is None:
        return None
    command = ["gh", kind, "list", "--json", "name"]
    if repo:
        command += ["--repo", repo]
    try:
        output = subprocess.run(
            command, capture_output=True, text=True, timeout=30, check=True
        ).stdout
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None
    try:
        return {entry["name"] for entry in json.loads(output)}
    except (json.JSONDecodeError, TypeError, KeyError):
        return None


def build_report(
    *,
    secret_names: set[str] | None,
    variable_names: set[str] | None,
    confirmed: set[str],
) -> Report:
    """Assemble the checklist. Pure, so the ordering and wording are testable."""
    report = Report()

    for key, description in MANUAL_STEPS.items():
        report.checks.append(
            Check(
                key=key,
                description=description,
                done=key in confirmed,
                hint=f"Do it, then record it: scripts/altstore_pal_preflight.py --confirm {key}",
            )
        )

    for name, description in REQUIRED_VARIABLES.items():
        known = variable_names is not None
        report.checks.append(
            Check(
                key=name,
                description=f"{name} — {description}",
                done=known and name in variable_names,
                hint=(
                    f"gh variable set {name}"
                    if known
                    else "Could not read the repository's variables; is `gh` signed in?"
                ),
            )
        )

    for name, description in REQUIRED_SECRETS.items():
        known = secret_names is not None
        report.checks.append(
            Check(
                key=name,
                description=f"{name} — {description}",
                done=known and name in secret_names,
                hint=(
                    f"gh secret set {name} < file"
                    if known
                    else "Could not read the repository's secrets; is `gh` signed in?"
                ),
            )
        )

    return report


def load_confirmed(path) -> set[str]:
    try:
        return set(json.loads(path.read_text(encoding="utf-8")).get("confirmed", []))
    except (OSError, json.JSONDecodeError):
        return set()


def save_confirmed(path, confirmed: set[str]) -> None:
    path.write_text(
        json.dumps({"confirmed": sorted(confirmed)}, indent=2) + "\n", encoding="utf-8"
    )


def main() -> int:
    from pathlib import Path

    repo_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--confirm",
        action="append",
        default=[],
        choices=sorted(MANUAL_STEPS),
        help="Record a manual step as done.",
    )
    parser.add_argument(
        "--unconfirm",
        action="append",
        default=[],
        choices=sorted(MANUAL_STEPS),
        help="Undo a recorded manual step.",
    )
    parser.add_argument("--repo", help="Repository to inspect, e.g. Arzuparreta/soundsible.")
    args = parser.parse_args()

    state_path = repo_root / "ios" / STATE_FILE
    confirmed = load_confirmed(state_path)
    if args.confirm or args.unconfirm:
        confirmed |= set(args.confirm)
        confirmed -= set(args.unconfirm)
        state_path.parent.mkdir(parents=True, exist_ok=True)
        save_confirmed(state_path, confirmed)

    report = build_report(
        secret_names=gh_names("secret", args.repo),
        variable_names=gh_names("variable", args.repo),
        confirmed=confirmed,
    )

    print("AltStore PAL readiness\n")
    for check in report.checks:
        print(f"  [{'x' if check.done else ' '}] {check.description}")

    if report.ready:
        print(
            "\nEverything is in place. Run the `iOS AltStore PAL` workflow to "
            "build, sign and upload, then submit for Notarization."
        )
        return 0

    nxt = report.remaining[0]
    print(f"\n{len(report.remaining)} step(s) left. Next:\n  {nxt.description}\n  {nxt.hint}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
