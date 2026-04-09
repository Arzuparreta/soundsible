import threading
import logging
import time
from concurrent.futures import ThreadPoolExecutor, Future
from typing import Callable, Any, Dict, List, Optional

logger = logging.getLogger(__name__)

class JobOrchestrator:
    """
    Manages background jobs with resource lanes and serialized commits.
    - TRANSCODE/DOWNLOAD lane: Concurrent workers.
    - METADATA lane: Serialized (one at a time).
    """
    
    _instance = None
    _lock = threading.Lock()

    @classmethod
    def get_instance(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    def __init__(self, max_workers: int = 3):
        self.executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="JobOrch")
        self.commit_lock = threading.Lock()
        self.active_jobs: Dict[str, Future] = {}
        self.state_lock = threading.Lock()
        
        # For metadata coalescing
        self.pending_commits = False
        self.last_commit_time = 0
        self.commit_debounce_sec = 2.0
        self.commit_timer: Optional[threading.Timer] = None

    def submit_task(self, task_id: str, func: Callable, *args, **kwargs) -> Future:
        """Submit a general task (e.g. download/transcode) to the thread pool."""
        with self.state_lock:
            # If a task with same ID is already running, return it
            if task_id in self.active_jobs:
                return self.active_jobs[task_id]
            
            future = self.executor.submit(self._wrap_task, task_id, func, *args, **kwargs)
            self.active_jobs[task_id] = future
            return future

    def _wrap_task(self, task_id: str, func: Callable, *args, **kwargs):
        try:
            return func(*args, **kwargs)
        except Exception as e:
            logger.error(f"Orchestrator: Task {task_id} failed: {e}")
            raise
        finally:
            with self.state_lock:
                if task_id in self.active_jobs:
                    del self.active_jobs[task_id]

    def run_serialized(self, func: Callable, *args, **kwargs):
        """Run a task exclusively (e.g. metadata write)."""
        with self.commit_lock:
            return func(*args, **kwargs)

    def schedule_metadata_commit(self, commit_func: Callable, emit_func: Optional[Callable] = None):
        """
        Schedule a metadata commit with debouncing/coalescing.
        Multiple calls in short succession will trigger only one commit.
        """
        with self.state_lock:
            self.pending_commits = True
            
            if self.commit_timer:
                self.commit_timer.cancel()
            
            def _do_commit():
                with self.commit_lock:
                    logger.info("Orchestrator: Executing coalesced metadata commit...")
                    try:
                        commit_func()
                        if emit_func:
                            emit_func()
                    except Exception as e:
                        logger.error(f"Orchestrator: Metadata commit failed: {e}")
                    finally:
                        with self.state_lock:
                            self.pending_commits = False
                            self.last_commit_time = time.time()
                            self.commit_timer = None

            self.commit_timer = threading.Timer(self.commit_debounce_sec, _do_commit)
            self.commit_timer.start()
            logger.debug("Orchestrator: Metadata commit scheduled (debounced).")

orchestrator = JobOrchestrator.get_instance()
