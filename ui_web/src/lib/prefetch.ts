import { api } from './api';
import type { PreviewPreparation } from './api';
import { isPodcastTrack } from './track';
import type { Track } from '../types/music';

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const WARM_TTL_MS = 4 * 60 * 1000;
const RETENTION_MS = 10 * 60 * 1000;
const MAX_INACTIVE = 256;
const POLL_MS = 1000;
const READY_POLL_MS = 30_000;
const RETRY_MS = 2000;
type Listener = (id: string, status: PreviewPreparation) => void;
type Client = Pick<typeof api, 'prefetchPreviews' | 'previewStatuses'>;

export interface PreparationOwner {
  update(ids: string[]): void;
  revalidate(): void;
  dispose(): void;
}

interface Entry {
  status?: PreviewPreparation;
  touched: number;
  warmUntil: number;
  retryAt: number;
  due: number;
  download: boolean;
  forced: boolean;
  generation: number;
  inFlight: number;
  owners: Set<Listener>;
}

/** One controller per page; injectable transport makes lifecycle tests isolated. */
export class PreviewPrefetch {
  private entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private nextStatusAt = 0;
  private disposed = false;

  constructor(
    private client: Client,
    private visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  ) {}

  private entry(id: string): Entry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { touched: Date.now(), warmUntil: 0, retryAt: 0, due: Infinity,
        download: false, forced: false, generation: 0, inFlight: 0, owners: new Set() };
      this.entries.set(id, entry);
    }
    entry.touched = Date.now();
    // Map order is the inactive LRU; polling order uses due timestamps.
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry;
  }

  private prune(): void {
    const inactive = [...this.entries].filter(([, e]) => !e.owners.size && !e.inFlight);
    let excess = inactive.length - MAX_INACTIVE;
    for (const [id, e] of inactive) {
      if (excess > 0 || Date.now() - e.touched >= RETENTION_MS) {
        this.entries.delete(id);
        excess--;
      }
    }
  }

  /** Counts only: useful for verifying retention without exposing cache contents. */
  stats(): { entries: number; inactive: number; subscriptions: number; inFlight: number } {
    this.prune();
    const values = [...this.entries.values()];
    return {
      entries: values.length,
      inactive: values.filter(e => !e.owners.size && !e.inFlight).length,
      subscriptions: values.reduce((n, e) => n + e.owners.size, 0),
      inFlight: values.reduce((n, e) => n + e.inFlight, 0),
    };
  }

  preparation(id: string): PreviewPreparation | undefined {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entry(id);
    return entry.status;
  }

  owner(listener: Listener): PreparationOwner {
    let ids = new Set<string>();
    let disposed = false;
    // Distinct owners may use the same callback.
    const notify: Listener = (id, status) => listener(id, status);
    const update = (values: string[]): void => {
      if (disposed || this.disposed) return;
      const next = new Set(values.filter(id => YT_ID_RE.test(id)));
      for (const id of ids) {
        if (next.has(id)) continue;
        const e = this.entries.get(id);
        if (!e) continue;
        e.owners.delete(notify);
        e.touched = Date.now();
        if (!e.owners.size) {
          e.generation++;
          e.due = Infinity;
        }
      }
      const previous = ids;
      ids = next;
      for (const id of next) {
        if (previous.has(id)) continue;
        const e = this.entry(id);
        if (!e.owners.size) {
          e.generation++;
          // Cached verdicts require confirmation when interest returns.
          e.forced = true;
          e.download = !e.status;
          e.due = e.download ? Math.max(Date.now(), e.retryAt) : Date.now();
        }
        e.owners.add(notify);
      }
      this.schedule();
    };
    return {
      update,
      revalidate: () => {
        if (disposed || this.disposed) return;
        for (const id of ids) {
          const e = this.entries.get(id);
          if (!e) continue;
          e.forced = true;
          e.generation++; // supersede an older response already in flight
          e.download = false;
          e.due = Date.now();
        }
        this.schedule();
      },
      dispose: () => {
        update([]);
        disposed = true;
      },
    };
  }

  warm(ids: string[]): void {
    if (this.disposed) return;
    this.prune();
    const selected = [...new Set(ids)].filter(id =>
      YT_ID_RE.test(id) && (this.entries.get(id)?.warmUntil ?? -Infinity) <= Date.now(),
    ).slice(0, 8);
    if (!selected.length) return;
    const entries = selected.map(id => {
      const e = this.entry(id);
      e.warmUntil = Date.now() + WARM_TTL_MS;
      e.inFlight++;
      return e;
    });
    void (async () => {
      try {
        await this.client.prefetchPreviews(selected, false);
      } catch {
        for (const e of entries) e.warmUntil = 0;
      } finally {
        for (const e of entries) e.inFlight--;
        this.schedule();
      }
    })();
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed) return;
    this.prune();
    let next = Infinity;
    for (const e of this.entries.values()) {
      if (!e.owners.size && !e.inFlight) next = Math.min(next, e.touched + RETENTION_MS);
      if (!this.busy && e.owners.size && !e.inFlight) {
        if (e.status?.state !== 'ready' || this.visible() || e.forced) {
          next = Math.min(next, e.download ? e.due : Math.max(e.due, this.nextStatusAt));
        }
      }
    }
    if (Number.isFinite(next)) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.poll(); }, Math.max(0, next - Date.now()));
    }
  }

  private async poll(): Promise<void> {
    this.prune();
    if (this.busy || this.disposed) { this.schedule(); return; }
    const due = [...this.entries].filter(([, e]) => e.owners.size && !e.inFlight && e.due <= Date.now()
      && (e.download || this.nextStatusAt <= Date.now())
      && (e.status?.state !== 'ready' || this.visible() || e.forced))
      .sort((a, b) => a[1].due - b[1].due);
    if (!due.length) { this.schedule(); return; }
    const download = due[0][1].download;
    const batch = due.filter(([, e]) => e.download === download).slice(0, 8)
      .map(([id, e]) => ({ id, e, generation: e.generation }));
    this.busy = true;
    for (const { e } of batch) e.inFlight++;
    try {
      const ids = batch.map(({ id }) => id);
      if (download) for (const { e } of batch) e.retryAt = Date.now() + RETRY_MS;
      if (!download) this.nextStatusAt = Date.now() + POLL_MS;
      const result = download
        ? await this.client.prefetchPreviews(ids, true)
        : await this.client.previewStatuses(ids);
      for (const { id, e, generation } of batch) {
        if (this.disposed || generation !== e.generation || !e.owners.size) continue;
        const status = result.preparation?.[id];
        e.forced = false;
        e.download = false;
        e.due = Date.now() + POLL_MS;
        if (!status) continue; // older engine: unknown, never assumed ready
        e.status = status;
        e.retryAt = Math.max(e.retryAt, Date.now() + (status.retry_after ?? 0) * 1000);
        if (status.state === 'ready') e.due = Date.now() + READY_POLL_MS;
        if (status.state === 'unavailable') e.due = Infinity;
        if (status.state === 'cold') {
          e.download = true;
          e.due = Math.max(Date.now() + POLL_MS, e.retryAt);
        }
        for (const listener of [...e.owners]) {
          if (generation !== e.generation || !e.owners.has(listener)) continue;
          listener(id, status);
        }
      }
    } catch {
      for (const { e, generation } of batch) {
        if (generation !== e.generation) continue;
        // A timeout may have accepted a download. Ask for its status first.
        e.forced = false;
        e.download = false;
        e.due = Date.now() + (e.status?.state === 'ready' ? READY_POLL_MS : POLL_MS);
      }
    } finally {
      for (const { e } of batch) e.inFlight--;
      this.busy = false;
      this.schedule();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.entries.clear();
  }
}

const previews = new PreviewPrefetch(api);
export const createPreparationOwner = (listener: Listener): PreparationOwner => previews.owner(listener);
export const previewPreparation = (id: string): PreviewPreparation | undefined => previews.preparation(id);
export const previewPreparationState = (id: string): PreviewPreparation['state'] | undefined => previews.preparation(id)?.state;
/** Speculative URL warming only; downloads require an explicit owner. */
export const prefetchPreviews = (ids: string[]): void => previews.warm(ids);

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
