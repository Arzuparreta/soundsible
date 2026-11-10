#!/usr/bin/env python3
"""Emulator shards of equal duration, from measured test times.

AndroidJUnitRunner's own sharding (`shardIndex`/`numShards`) assigns each test
by the hash of its name. On run 42923525702 (2026-11-10) that gave the eight
shards between 252 s and 469 s of tests each, and a pull request waits for the
slowest one.

This assigns tests by what they measured instead. Every shard but the last
runs an explicit list of tests; the last runs *everything that is not on
another shard's list*. A test this file has never heard of — new, or renamed —
therefore still runs, on the last shard, and no list has to be complete for
the suite to be.

Refresh the timings from the result files of a CI run when the last shard has
grown or the suite has changed shape:

    gh run download <run id> -p 'soundsible-android-emulator-*' -D /tmp/shards
    python scripts/android_shards.py refresh /tmp/shards
"""
from __future__ import annotations

import json
import re
import sys
import xml.etree.ElementTree as ElementTree
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TIMINGS = ROOT / "android/test-timings.json"
SOURCES = ROOT / "android/app/src/androidTest/java"
# What shard 0 does besides its slice: the offline smoke run, the two
# process-restart protocols and the final install. Measured as the difference
# between its step and the steps of shards with the same amount of tests.
FIRST_SHARD_EXTRA_SECONDS = 70.0


def load_timings(path: Path = TIMINGS) -> dict[str, float]:
    return {name: float(seconds) for name, seconds in json.loads(path.read_text(encoding="utf-8")).items()}


def exists(name: str, sources: Path = SOURCES) -> bool:
    """Whether `package.Class#method` is still in the instrumented sources.

    A list naming a test that is gone makes the runner fail before any test
    runs. Only used to drop names, so a wrong "no" costs nothing: the test
    then runs on the last shard like any other unlisted one.
    """
    owner, _, method = name.partition("#")
    relative = Path(*owner.split("."))
    for suffix in (".java", ".kt"):
        source = (sources / relative).with_suffix(suffix)
        if source.is_file():
            return re.search(rf"\b{re.escape(method)}\s*\(", source.read_text(encoding="utf-8")) is not None
    return False


def plan(timings: dict[str, float], count: int) -> list[list[str]]:
    """Longest test first, each onto the shard with the least work so far."""
    shards: list[list[str]] = [[] for _ in range(count)]
    load = [0.0] * count
    load[0] = FIRST_SHARD_EXTRA_SECONDS
    for name, seconds in sorted(timings.items(), key=lambda item: (-item[1], item[0])):
        target = min(range(count), key=lambda index: (load[index], index))
        shards[target].append(name)
        load[target] += seconds
    return shards


def runner_arguments(index: int, count: int, *, excluded: tuple[str, ...] = (),
                     timings: dict[str, float] | None = None, sources: Path = SOURCES) -> dict[str, str]:
    """The `class` / `notClass` instrumentation arguments for one shard.

    `excluded` are classes no shard of this run executes (the restart
    protocols, which shard 0 drives phase by phase).
    """
    if not 0 <= index < count:
        raise ValueError("shard index out of range")
    known = load_timings() if timings is None else timings
    known = {name: seconds for name, seconds in known.items()
             if name.partition("#")[0] not in excluded and exists(name, sources)}
    shards = plan(known, count)
    if index == count - 1:
        listed = sorted(name for shard in shards[:-1] for name in shard)
        return {"notClass": ",".join((*excluded, *listed))}
    if not shards[index]:
        # An empty `class` argument would run the whole suite on this shard.
        raise RuntimeError(f"No measured test for shard {index}/{count}; refresh android/test-timings.json")
    arguments = {"class": ",".join(sorted(shards[index]))}
    if excluded:
        arguments["notClass"] = ",".join(excluded)
    return arguments


def read_results(directory: Path) -> dict[str, float]:
    """`package.Class#method` → seconds from every JUnit XML under `directory`."""
    measured: dict[str, float] = {}
    for report in sorted(directory.rglob("TEST-*.xml")):
        for case in ElementTree.parse(report).getroot().iter("testcase"):
            name = f"{case.get('classname')}#{case.get('name')}"
            measured[name] = max(measured.get(name, 0.0), float(case.get("time") or 0))
    return measured


def refresh(directory: Path) -> None:
    measured = read_results(directory)
    if not measured:
        raise SystemExit(f"No JUnit result under {directory}")
    # Keep what this run did not execute (a failed shard), drop what is gone.
    previous = load_timings() if TIMINGS.is_file() else {}
    merged = {name: seconds for name, seconds in {**previous, **measured}.items() if exists(name)}
    TIMINGS.write_text(
        json.dumps({name: round(merged[name], 1) for name in sorted(merged)}, indent=2) + "\n", encoding="utf-8")
    loads = [sum(merged[name] for name in shard) for shard in plan(merged, 8)]
    print(f"{len(merged)} tests, {sum(merged.values()):.0f} s; eight shards carry "
          + ", ".join(f"{load:.0f}" for load in loads) + " s")


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "refresh":
        raise SystemExit(__doc__)
    refresh(Path(sys.argv[2]))
