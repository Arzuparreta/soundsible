import { ApiError } from './http';
import type { LyricsResponse } from '../types/music';

const RECOVERY_MS = 60_000;
// Keep the first poll quick; subsequent polls stay below the 60/minute API limit.
const POLL_MS = 1_500;
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000];

function unavailable(): LyricsResponse {
  return { status: 'unavailable', synced: null, plain: null, instrumental: false, cached: false, pending: false };
}

function cancelled(): DOMException {
  return new DOMException('Lyrics lookup cancelled', 'AbortError');
}

function transient(error: unknown): boolean {
  return error instanceof TypeError // fetch cannot reach the engine
    || (error instanceof DOMException && error.name === 'AbortError') // request timeout
    || (error instanceof ApiError && (error.status === 408 || error.status === 429 || error.status >= 500));
}

function wait(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    const abort = () => { clearTimeout(timer); reject(cancelled()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Recover a temporary outage without lengthening the engine's bounded jobs.
 * Between failed jobs its two lookup slots are free for other listeners.
 * One deadline covers polling, requests and backoff, whatever the network speed.
 */
export async function lookupLyrics(
  request: (signal: AbortSignal) => Promise<LyricsResponse>,
  signal: AbortSignal,
): Promise<LyricsResponse> {
  if (signal.aborted) throw cancelled();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, RECOVERY_MS);
  let failures = 0;
  let pollDelay = 750;
  try {
    while (!controller.signal.aborted) {
      let result: LyricsResponse | undefined;
      try {
        result = await request(controller.signal);
      } catch (error) {
        if (controller.signal.aborted || !transient(error)) throw error;
      }
      if (controller.signal.aborted) break;
      if (result && !result.pending && result.status !== 'pending' && result.status !== 'unavailable') return result;
      const pending = result?.pending || result?.status === 'pending';
      const delay = pending
        ? pollDelay
        : RETRY_DELAYS_MS[Math.min(failures++, RETRY_DELAYS_MS.length - 1)] + Math.random() * 250;
      pollDelay = pending ? POLL_MS : 750;
      await wait(delay, controller.signal);
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
  if (signal.aborted) throw cancelled();
  return unavailable();
}
