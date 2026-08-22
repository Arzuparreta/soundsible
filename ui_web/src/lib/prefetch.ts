import { api } from './api';
import type { PreviewPreparation } from './api';
import { isPodcastTrack } from './track';
import type { Track } from '../types/music';

/** YouTube video ids are exactly 11 URL-safe base64 chars. */
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** The engine's stream-URL cache lives ~5 min; re-warm shortly before it dies. */
const WARM_TTL_MS = 4 * 60 * 1000;
const lastWarm = new Map<string, number>();
const lastDownloadAttempt = new Map<string, number>();
const DOWNLOAD_RETRY_MS = 2000;
const preparation = new Map<string, PreviewPreparation>();
const observed = new Set<string>();
type PreparationListener = (videoId: string, status: PreviewPreparation) => void;
const preparationListeners = new Map<string, Set<PreparationListener>>();
let observationTimer: ReturnType<typeof setTimeout> | null = null;
const STATUS_POLL_MS = 1000;

function applyPreparation(rows: Record<string, PreviewPreparation> | undefined): void {
  if (!rows) return;
  for (const [id, status] of Object.entries(rows)) {
    preparation.set(id, status);
    const terminal = status.state === 'ready' || status.state === 'unavailable';
    if (terminal) observed.delete(id);
    else observed.add(id);
    for (const listener of preparationListeners.get(id) ?? []) listener(id, status);
    if (terminal) preparationListeners.delete(id);
  }
}

function scheduleObservation(): void {
  if (observationTimer || observed.size === 0) return;
  observationTimer = setTimeout(async () => {
    observationTimer = null;
    const ids = [...observed].slice(0, 8);
    if (ids.length === 0) return;
    try {
      const result = await api.previewStatuses(ids);
      applyPreparation(result.preparation);
      const lost = ids.filter((id) => result.preparation?.[id]?.state === 'cold');
      if (lost.length > 0) {
        // The engine restarted or lost an accepted worker job. Re-submit it;
        // polling a permanently cold status is not persistence.
        for (const id of lost) {
          observed.delete(id);
          lastDownloadAttempt.delete(id);
        }
        prefetchPreviews(lost, { download: true });
      }
    } catch {
      // Connectivity loss is not evidence that a prepared file disappeared.
    }
    scheduleObservation();
  }, STATUS_POLL_MS);
}

/** Server-confirmed disk readiness. `undefined` means no preparation attempt
 * has been observed, never "probably ready". */
export function previewPreparationState(videoId: string): PreviewPreparation['state'] | undefined {
  return preparation.get(videoId)?.state;
}

/**
 * Warm previews before the user clicks play: the engine resolves the stream
 * URL in the background, and with `download` also lands the whole audio file
 * in its disk cache. Fire-and-forget — playback works the same without it,
 * just slower.
 */
export function prefetchPreviews(
  videoIds: string[],
  opts: { download?: boolean; onStatus?: PreparationListener } = {},
): void {
  const now = Date.now();
  const validIds = [...new Set(videoIds)].filter((id) => YT_ID_RE.test(id));
  if (opts.onStatus) {
    for (const id of validIds) {
      const known = preparation.get(id);
      if (known?.state === 'ready') continue;
      if (known?.state === 'unavailable') {
        opts.onStatus(id, known);
        continue;
      }
      const listeners = preparationListeners.get(id) ?? new Set<PreparationListener>();
      listeners.add(opts.onStatus);
      preparationListeners.set(id, listeners);
    }
  }
  const ids = validIds
    .filter((id) => {
      if (!opts.download) return now - (lastWarm.get(id) ?? 0) > WARM_TTL_MS;
      const status = preparation.get(id);
      if (status?.state === 'ready' || status?.state === 'pending' || observed.has(id)) return false;
      const retryMs = Math.max(DOWNLOAD_RETRY_MS, (status?.retry_after ?? 0) * 1000);
      return now - (lastDownloadAttempt.get(id) ?? 0) >= retryMs;
    })
    .slice(0, 8);
  if (ids.length === 0) return;
  for (const id of ids) lastWarm.set(id, now);
  if (opts.download) for (const id of ids) lastDownloadAttempt.set(id, now);
  const releaseFailedWarm = (): void => {
    for (const id of ids) {
      if (lastWarm.get(id) === now) lastWarm.delete(id);
      if (opts.download && lastDownloadAttempt.get(id) === now) {
        lastDownloadAttempt.delete(id);
        observed.add(id);
      }
    }
    if (opts.download) scheduleObservation();
  };
  try {
    void api.prefetchPreviews(ids, opts.download ?? false).then((result) => {
      if (!opts.download) return;
      applyPreparation(result.preparation);
      // Older engines do not return the observable contract. Keep the state
      // unknown rather than upgrading "request accepted" into "audio ready".
      for (const id of ids) {
        if (!preparation.has(id)) preparation.set(id, { state: 'cold' });
        observed.add(id);
      }
      scheduleObservation();
    }).catch(releaseFailedWarm);
  } catch {
    releaseFailedWarm();
  }
}

/**
 * The next preview tracks in linear queue order (what `actions.next` will
 * reach). Library tracks are skipped (already on disk); podcasts stream via
 * minted tokens the engine cannot prefetch.
 */
export function upcomingPreviewIds(queue: Track[], index: number, repeatAll: boolean, count = 2): string[] {
  const ids: string[] = [];
  const n = queue.length;
  for (let step = 1; step < n && ids.length < count; step++) {
    let j = index + step;
    if (j >= n) {
      if (!repeatAll) break;
      j %= n;
    }
    const t = queue[j];
    if (t && t.source === 'preview' && !isPodcastTrack(t)) ids.push(t.id);
  }
  return ids;
}
