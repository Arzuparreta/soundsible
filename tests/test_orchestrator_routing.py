"""
Regression tests for plan T3 — disk-heavy startup/admin paths must route
through JobOrchestrator (visible in active_jobs, capped by disk profile)
instead of raw threading.Thread.

Covers:
  - optimization and sync admin tasks submit via orchestrator.submit_task
  - yt-dlp startup auto-update submits via orchestrator.submit_background
"""

import ast
from pathlib import Path
from unittest.mock import MagicMock, patch

import shared.api as api_mod


REPO_ROOT = Path(__file__).resolve().parents[1]


def _source(rel_path: str) -> str:
    return (REPO_ROOT / rel_path).read_text(encoding="utf-8")


def test_optimize_and_sync_routes_no_longer_spawn_threads():
    """The two admin routes must not wrap run_*_task in threading.Thread —
    the inner tasks already submit to the orchestrator."""
    src = _source("shared/api/routes/downloader.py")
    tree = ast.parse(src)

    def fn(name):
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == name:
                return node
        raise AssertionError(f"function {name} not found")

    for fname in ("trigger_downloader_optimize", "trigger_downloader_sync"):
        body_src = ast.unparse(fn(fname))
        assert "threading.Thread" not in body_src, (
            f"{fname} still spawns a raw Thread; should call the *_task "
            f"function directly (orchestrator handles concurrency)"
        )


def test_run_optimization_task_submits_to_orchestrator():
    """Calling run_optimization_task must enqueue exactly one job on the
    orchestrator under the well-known id 'optimization'."""
    with patch.object(api_mod.orchestrator, "submit_task") as submit:
        submit.return_value = MagicMock()
        api_mod.run_optimization_task(dry_run=True)
        assert submit.called, "run_optimization_task did not submit any job"
        task_id = submit.call_args.args[0]
        assert task_id == "optimization"


def test_run_sync_task_submits_to_orchestrator():
    with patch.object(api_mod.orchestrator, "submit_task") as submit:
        submit.return_value = MagicMock()
        api_mod.run_sync_task()
        assert submit.called, "run_sync_task did not submit any job"
        task_id = submit.call_args.args[0]
        assert task_id == "sync"


def test_ytdlp_autoupdate_uses_orchestrator_not_thread():
    """The startup hook must route yt-dlp pip update via submit_background,
    not a raw daemon Thread — otherwise it competes with playback I/O
    without being tracked in active_jobs."""
    src = _source("shared/api/__init__.py")
    # Find the conditional block that handles _defer_ytdlp_thread.
    idx = src.find("_defer_ytdlp_thread and _run_ytdlp_update")
    assert idx != -1, "yt-dlp deferred-startup block not found"
    snippet = src[idx : idx + 400]
    assert "submit_background" in snippet, (
        "yt-dlp update should go through orchestrator.submit_background"
    )
    assert "threading.Thread(target=_run_ytdlp_update" not in snippet, (
        "yt-dlp update is still using a raw Thread"
    )
