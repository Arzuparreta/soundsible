"""The duration-based split of the Android emulator suite."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import android_shards as shards

EXCLUDED = ("com.soundsible.android.OfflineRestartTest",)


def _sources(tmp_path, tests):
    for name in tests:
        owner, _, method = name.partition("#")
        source = (tmp_path / Path(*owner.split("."))).with_suffix(".java")
        source.parent.mkdir(parents=True, exist_ok=True)
        with source.open("a") as handle:
            handle.write(f"@Test public void {method}() {{}}\n")
    return tmp_path


def test_every_measured_test_runs_on_exactly_one_shard_and_unknown_ones_on_the_last(tmp_path):
    timings = {f"com.x.T{i}#case{i}": float(20 + 10 * (i % 7)) for i in range(40)}
    sources = _sources(tmp_path, timings)
    explicit = []
    for index in range(7):
        arguments = shards.runner_arguments(index, 8, excluded=EXCLUDED, timings=timings, sources=sources)
        assert arguments["notClass"] == EXCLUDED[0]
        explicit += arguments["class"].split(",")
    last = shards.runner_arguments(7, 8, excluded=EXCLUDED, timings=timings, sources=sources)
    assert "class" not in last, "the last shard runs whatever nobody else lists, including new tests"
    assert len(explicit) == len(set(explicit))
    assert set(last["notClass"].split(",")) == {*EXCLUDED, *explicit}
    assert set(timings) - set(explicit), "the last shard has measured work of its own"


def test_shards_carry_equal_work_and_the_first_one_less():
    timings = {f"com.x.T#case{i}": 10.0 for i in range(87)}
    loads = [10.0 * len(shard) for shard in shards.plan(timings, 8)]
    assert max(loads[1:]) - min(loads[1:]) <= 10.0
    assert loads[0] + shards.FIRST_SHARD_EXTRA_SECONDS <= max(loads[1:]) + 10.0
    assert loads[0] < min(loads[1:])


def test_a_removed_or_excluded_test_is_named_on_no_shard(tmp_path):
    timings = {"com.x.Kept#stays": 90.0, "com.x.Kept#removed": 90.0, "com.x.Gone#any": 90.0,
               EXCLUDED[0] + "#offlinePhase": 90.0, "com.x.Other#stays": 90.0}
    sources = _sources(tmp_path, ["com.x.Kept#stays", "com.x.Other#stays", EXCLUDED[0] + "#offlinePhase"])
    named = ",".join(
        value for index in range(2)
        for value in shards.runner_arguments(index, 2, excluded=EXCLUDED, timings=timings, sources=sources).values())
    assert "removed" not in named and "Gone" not in named and "offlinePhase" not in named
    assert "com.x.Other#stays" in named


def test_a_shard_with_nothing_measured_refuses_to_run_the_whole_suite(tmp_path):
    timings = {"com.x.Only#one": 5.0}
    with pytest.raises(RuntimeError, match="refresh"):
        shards.runner_arguments(2, 8, timings=timings, sources=_sources(tmp_path, timings))


def test_the_committed_timings_name_only_tests_that_exist_and_fill_every_ci_shard():
    import yaml

    workflow = Path(__file__).resolve().parents[1] / ".github/workflows/android-build.yml"
    count = len(yaml.safe_load(workflow.read_text())["jobs"]["emulator"]["strategy"]["matrix"]["shard"])
    timings = shards.load_timings()
    assert all(shards.exists(name) for name in timings), "run scripts/android_shards.py refresh"
    for index in range(count):
        shards.runner_arguments(index, count)
