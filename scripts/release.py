#!/usr/bin/env python3
"""Cut a Soundsible release without anyone having to choose a number.

The impact of a change is decided once, by whoever writes it, as an
``impact:`` label on the pull request. This reads the labels of everything
merged since the last tag and derives the next version from them, so releasing
is never a judgement call made weeks later by someone reading a diff.

Three steps, deliberately separate so a half-finished release is always in an
obvious state:

    plan      what would be released, and as what number
    prepare   open the version-bump pull request, with auto-merge armed
    finish    once that pull request is in, tag the merge commit

`prepare` opens a pull request rather than pushing to `main` because the
repository ruleset forbids the latter, and it runs from a developer or agent
checkout rather than from Actions because a `GITHUB_TOKEN` push triggers no
workflows — a bot-authored release would sit forever without the required
checks, and its tag would build nothing.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

# scripts/ is a directory of standalone tools, not an importable package, so
# the sibling module has to be reachable before it can be imported.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from version_sync import (  # noqa: E402
    declared_version,
    set_declared_version,
    sync,
    validate,
)

#: Ordered by how much they move the number. `none` is not absence of a label:
#: it is the explicit claim that a change ships nothing a user would notice.
IMPACTS = ("none", "patch", "minor", "major")
LABEL_PREFIX = "impact:"

#: A pull request merged before the labels existed. Counted as a patch so the
#: first release after this system lands is not blocked by history, and always
#: listed by name so the claim can be checked.
UNLABELLED = "patch"

VERSION_RE = re.compile(
    r"^(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)(?:-rc\.(?P<rc>\d+))?$"
)


def run(*args: str, check: bool = True) -> str:
    """Run a command and return its stdout, stripped."""
    result = subprocess.run(
        args, capture_output=True, text=True, check=False, encoding="utf-8"
    )
    if check and result.returncode != 0:
        raise SystemExit(
            f"$ {' '.join(args)}\n{result.stdout}{result.stderr}".rstrip()
        )
    return result.stdout.strip()


def attempt(*args: str) -> bool:
    """Run a command whose failure is survivable. True if it worked.

    Used for the steps that come after the pull request already exists.
    Dying there would leave the release half-made — a branch pushed and a pull
    request open — behind a stack trace that says nothing about how to finish.
    """
    result = subprocess.run(
        args, capture_output=True, text=True, check=False, encoding="utf-8"
    )
    if result.returncode == 0:
        return True
    print(f"  {result.stderr.strip() or result.stdout.strip()}", file=sys.stderr)
    return False


@dataclass(frozen=True)
class MergedPR:
    number: int
    title: str
    impact: str
    labelled: bool

    @property
    def line(self) -> str:
        return f"- #{self.number} {self.title}"


def last_tag() -> str | None:
    """The most recent ``vX.Y.Z`` tag, or None if nothing was ever released."""
    tags = run(
        "git", "tag", "--list", "v*", "--sort=-v:refname", "--merged", "origin/main"
    )
    return tags.splitlines()[0] if tags else None


def merged_since(tag: str | None) -> list[MergedPR]:
    """Pull requests merged into main after ``tag`` was cut."""
    since = None
    if tag:
        since = run("git", "log", "-1", "--format=%cI", f"refs/tags/{tag}")

    raw = run(
        "gh", "pr", "list",
        "--state", "merged",
        "--base", "main",
        "--limit", "200",
        "--json", "number,title,labels,mergedAt",
    )
    pulls: list[MergedPR] = []
    for entry in json.loads(raw or "[]"):
        if since and entry["mergedAt"] <= since:
            continue
        labels = {
            label["name"][len(LABEL_PREFIX):]
            for label in entry["labels"]
            if label["name"].startswith(LABEL_PREFIX)
        }
        known = [name for name in IMPACTS if name in labels]
        pulls.append(
            MergedPR(
                number=entry["number"],
                title=entry["title"],
                impact=known[-1] if known else UNLABELLED,
                labelled=bool(known),
            )
        )
    return sorted(pulls, key=lambda pull: pull.number)


def next_version(current: str, impact: str, *, rc: bool) -> str:
    """Apply ``impact`` to ``current``.

    Below 1.0 a breaking change moves the minor, because that is what 0.x
    already promises: no stability guarantee across minors. Reaching 1.0 is a
    deliberate act, not something a label can trigger — pass --version for it.
    """
    match = VERSION_RE.match(current)
    if match is None:
        raise SystemExit(f"Cannot reason about the current version {current!r}.")
    major, minor, patch = (int(match.group(part)) for part in ("major", "minor", "patch"))
    in_progress_rc = match.group("rc")

    if in_progress_rc and rc:
        # Already stabilising this number: the next candidate, not a new line.
        return f"{major}.{minor}.{patch}-rc.{int(in_progress_rc) + 1}"
    if in_progress_rc:
        # An rc becoming final keeps its number and drops the suffix.
        return f"{major}.{minor}.{patch}"

    if impact == "major" and major >= 1:
        major, minor, patch = major + 1, 0, 0
    elif impact in ("major", "minor"):
        minor, patch = minor + 1, 0
    elif impact == "patch":
        patch += 1
    else:
        raise SystemExit("Nothing to release.")

    base = f"{major}.{minor}.{patch}"
    return f"{base}-rc.1" if rc else base


def summarise(pulls: list[MergedPR], tag: str | None) -> str:
    """The body of the bump pull request: what is going out, and why this number."""
    lines: list[str] = []
    since = f"since {tag}" if tag else "since the beginning of the repository"
    lines.append(f"Everything merged into `main` {since}.\n")
    for impact in reversed(IMPACTS):
        batch = [pull for pull in pulls if pull.impact == impact and pull.labelled]
        if batch:
            lines.append(f"### impact:{impact}\n")
            lines.extend(pull.line for pull in batch)
            lines.append("")
    unlabelled = [pull for pull in pulls if not pull.labelled]
    if unlabelled:
        lines.append(
            f"### No impact label — counted as `{UNLABELLED}`\n"
        )
        lines.extend(pull.line for pull in unlabelled)
        lines.append("")
    return "\n".join(lines)


def resolve(args: argparse.Namespace) -> tuple[str, str, list[MergedPR]]:
    """Return the version to release, the impact that chose it, and the changes."""
    run("git", "fetch", "--quiet", "--tags", "origin", "main")
    tag = last_tag()
    pulls = merged_since(tag)
    highest = max((pull.impact for pull in pulls), key=IMPACTS.index, default="none")

    if args.version:
        return validate(args.version), "explicit", pulls
    if highest == "none":
        raise SystemExit(
            "Nothing merged since "
            f"{tag or 'the beginning'} claims any user-visible impact."
        )
    return next_version(declared_version(), highest, rc=args.rc), highest, pulls


def cmd_plan(args: argparse.Namespace) -> int:
    version, impact, pulls = resolve(args)
    print(f"{declared_version()} → {version}  ({impact})\n")
    print(summarise(pulls, last_tag()))
    return 0


def cmd_prepare(args: argparse.Namespace) -> int:
    if run("git", "status", "--porcelain"):
        raise SystemExit("Working tree is dirty; commit or stash first.")

    version, impact, pulls = resolve(args)
    branch = f"release/v{version}"

    print(f"Releasing {declared_version()} → {version} ({impact})")
    run("git", "switch", "--quiet", "--create", branch, "origin/main")
    set_declared_version(version)
    sync(version, check=False)
    run("git", "commit", "--quiet", "--all", "--message", f"Versión {version}")
    run("git", "push", "--quiet", "--set-upstream", "origin", branch)

    body = (
        f"Bump to `{version}`, derived from the impact labels below.\n\n"
        f"{summarise(pulls, last_tag())}\n"
        "Merging this tags `v" + version + "` and publishes the images and "
        "installers. Nothing else in this pull request is hand-written: "
        "`scripts/version_sync.py` produced every changed line.\n"
    )
    url = run(
        "gh", "pr", "create",
        "--base", "main",
        "--title", f"Versión {version}",
        "--body", body,
        "--label", "impact:none",
    ).splitlines()[-1]
    print(f"\n{url}")
    if attempt("gh", "pr", "merge", url, "--squash", "--auto", "--delete-branch"):
        print("Auto-merge armed. When it lands: scripts/release.py finish")
    else:
        print(
            "Could not arm auto-merge — the pull request above is still good.\n"
            "Merge it yourself, then: scripts/release.py finish"
        )
    return 0


def cmd_finish(args: argparse.Namespace) -> int:
    run("git", "fetch", "--quiet", "--tags", "origin", "main")
    run("git", "switch", "--quiet", "main")
    run("git", "pull", "--quiet", "--ff-only")

    version = declared_version()
    tag = f"v{version}"
    if run("git", "tag", "--list", tag):
        raise SystemExit(f"{tag} already exists; this release is already out.")

    head = run("git", "rev-parse", "HEAD")
    if head != run("git", "rev-parse", "origin/main"):
        raise SystemExit("Local main is not what origin/main is; refusing to tag.")
    if sync(version, check=True):
        raise SystemExit("Manifests disagree with the declaration; not tagging.")

    run("git", "tag", "--annotate", tag, "--message", f"Soundsible {version}")
    run("git", "push", "origin", tag)
    print(f"{tag} → {head[:7]}. CI is building the release.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    subparsers = parser.add_subparsers(dest="command", required=True)

    for name, handler, help_text in (
        ("plan", cmd_plan, "show what would be released and as what number"),
        ("prepare", cmd_prepare, "open the version-bump pull request"),
        ("finish", cmd_finish, "tag the merged bump commit"),
    ):
        sub = subparsers.add_parser(name, help=help_text)
        sub.set_defaults(handler=handler)
        if name != "finish":
            sub.add_argument(
                "--version",
                help="release this exact version instead of the derived one",
            )
            sub.add_argument(
                "--rc",
                action="store_true",
                help="cut a release candidate instead of a stable release",
            )

    args = parser.parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
