"""
Regression tests for plan T3 — disk-heavy startup/admin paths must route
through JobOrchestrator (visible in active_jobs, capped by disk profile)
instead of raw threading.Thread.

Covers:
  - the sync admin task submits via orchestrator.submit_task
"""

import ast
from pathlib import Path
from unittest.mock import MagicMock, patch

from shared import library_tasks


REPO_ROOT = Path(__file__).resolve().parents[1]


def _source(rel_path: str) -> str:
    return (REPO_ROOT / rel_path).read_text(encoding="utf-8")


def test_sync_route_no_longer_spawns_a_thread():
    """The admin route must not wrap run_sync_task in threading.Thread —
    the inner task already submits to the orchestrator."""
    src = _source("shared/api/routes/downloader.py")
    tree = ast.parse(src)
    route = next(
        node for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name == "trigger_downloader_sync"
    )
    assert "threading.Thread" not in ast.unparse(route), (
        "trigger_downloader_sync still spawns a raw Thread; should call "
        "run_sync_task directly (orchestrator handles concurrency)"
    )


def test_run_sync_task_submits_to_orchestrator():
    with patch.object(library_tasks.orchestrator, "submit_task") as submit:
        submit.return_value = MagicMock()
        library_tasks.run_sync_task()
        assert submit.called, "run_sync_task did not submit any job"
        task_id = submit.call_args.args[0]
        assert task_id == "sync"
