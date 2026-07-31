/**
 * The download queue as the engine reports it, and what the UI derives from it.
 *
 * `applyDownloadEvent` runs on every `downloader_update` frame — several times
 * a second per active download — so its writes go through the store's path API
 * rather than rebuilding the queue array.
 */

import { setState, state } from './core';
import { syncLibrarySoon } from './library';
import { t as tr } from '../lib/i18n';
import type { CompletedDownload, DownloadEvent, DownloadQueueItem } from '../types/download';

/** Push a "just finished" entry to the recent strip and auto-expire it. */
export function addRecentCompleted(entry: CompletedDownload): void {
  if (state.downloads.recent.some((r) => r.id === entry.id)) return;
  setState('downloads', 'recent', (r) => [entry, ...r].slice(0, 5));
  setTimeout(() => {
    setState('downloads', 'recent', (r) => r.filter((x) => x.id !== entry.id));
  }, 5000);
}

/** Merge one `downloader_update` socket payload into the live queue. Mirrors the
 * legacy `mergeDownloaderEvent`: completed items leave the queue; unknown ids are
 * appended (covers events that arrive before the initial seed). */
export function applyDownloadEvent(detail: DownloadEvent): void {
  const { id, status, track, ...rest } = detail;
  if (!id) return;
  if (status === 'completed') {
    const finished = state.downloads.queue.find((i) => i.id === id);
    setState('downloads', 'queue', (q) => q.filter((i) => i.id !== id));
    addRecentCompleted({
      id,
      title: track?.title ?? finished?.display_title ?? finished?.podcast_title ?? tr('toast.trackFallback'),
      artist: track?.artist ?? finished?.display_artist ?? finished?.podcast_show_title ?? '',
    });
    // A completed download is emitted by the server *after* it has written the
    // new track to library.json (see shared/api/__init__.py), so the library is
    // already authoritative here. Refresh it instead of waiting on the
    // `library_updated` file-watcher event, which has a 2s debounce and can miss
    // or coalesce filesystem events — that lag is why a freshly downloaded track
    // wouldn't show up until the user re-entered the Library view.
    //
    // Coalesced: `syncLibrary` alone allows one in-flight plus one queued, so a
    // twelve-track album still issued several full-library round trips while
    // the device was decoding audio.
    syncLibrarySoon();
    return;
  }
  const index = state.downloads.queue.findIndex((item) => item.id === id);
  if (index === -1) {
    setState('downloads', 'queue', state.downloads.queue.length, {
      id,
      status: status ?? 'pending',
      ...rest,
    } as DownloadQueueItem);
    return;
  }
  // Progress events arrive several times a second per active download. Copying
  // the queue and respreading the row on each one re-ran every subscriber to
  // `downloads.queue`; a path write touches only the row that moved.
  setState('downloads', 'queue', index, {
    ...rest,
    status: status ?? state.downloads.queue[index].status,
  });
}


/** Reactive download tallies — call inside a tracking scope (createMemo). */
export function downloadCounts(): { active: number; failed: number } {
  let active = 0;
  let failed = 0;
  for (const i of state.downloads.queue) {
    if (i.status === 'failed' || i.status === 'interrupted') failed++;
    else active++;
  }
  return { active, failed };
}
