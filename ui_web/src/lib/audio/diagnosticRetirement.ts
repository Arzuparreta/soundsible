import { recordPlaybackDiagnostic, retirementVariant } from '../playbackDiagnostics';

/** One experimental retirement. Reuse/transport explicitly aborts its delay. */
export class DiagnosticRetirement {
  private pending: {
    release: () => void;
    deadline: number;
    timer: ReturnType<typeof setTimeout>;
    next?: { run: () => void; cancel?: () => void };
  } | null = null;

  retire(release: () => void, graphReady: boolean): void {
    this.flush('superseded');
    if (retirementVariant() !== 'delayed' || !graphReady) {
      if (retirementVariant() === 'delayed') recordPlaybackDiagnostic('retirement.delay_unavailable');
      release();
      return;
    }
    const deadline = performance.now() + 8000;
    this.pending = { release, deadline, timer: setTimeout(() => this.flush('deadline', true), 8000) };
    recordPlaybackDiagnostic('retirement.deferred', { delayMs: 8000 });
  }

  /** A committed transition takes priority over speculative preload. */
  defer(next: () => void, cancel?: () => void): boolean {
    if (!this.pending) return false;
    if (this.pending.next?.cancel && !cancel) return true;
    this.pending.next?.cancel?.();
    this.pending.next = { run: next, cancel };
    recordPlaybackDiagnostic('retirement.reuse_deferred');
    return true;
  }

  tick(): void {
    if (this.pending && performance.now() >= this.pending.deadline) this.flush('media_clock', true);
  }

  flush(reason: string, runNext = false): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    recordPlaybackDiagnostic('retirement.release', { reason, latenessMs: performance.now() - pending.deadline });
    pending.release();
    if (runNext) pending.next?.run();
    else pending.next?.cancel?.();
  }
}
