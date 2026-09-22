/** Unacknowledged batches survive reloads and offline trips, separately per account. */
export interface TraceBatch {
  id: string;
  userId: string;
  createdAt: number;
  capture: Record<string, string>;
  dropped: number;
  events: unknown[];
}
const MAX_BATCHES = 8192;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_AGE_MS = 7 * 86400_000;
const MAINTENANCE_ROWS = 64;
const SEND_BATCHES = 6;
const encoder = new TextEncoder();
interface StoredBatch {
  id: string;
  userId: string;
  createdAt: number;
  bytes: number;
  eventCount: number;
  batch: TraceBatch;
}
interface Account { userId: string; count: number; bytes: number; lost: number }
const account = (userId: string): Account => ({ userId, count: 0, bytes: 0, lost: 0 });
const stored = (batch: TraceBatch): StoredBatch => ({
  id: batch.id, userId: batch.userId, createdAt: batch.createdAt,
  bytes: encoder.encode(JSON.stringify(batch)).byteLength, eventCount: batch.events.length, batch,
});
const range = (userId: string, since?: number) => IDBKeyRange.bound(
  since === undefined ? [userId] : [userId, since], [userId, []],
);
function subtract(meta: Account, row: StoredBatch): void {
  meta.count--;
  meta.bytes -= row.bytes;
}

/** Only visit the oldest rows needed for this admission/maintenance budget. */
function trim(store: IDBObjectStore, meta: Account, extra: StoredBatch | undefined, budget: number, done: () => void): void {
  const request = store.index('accountDate').openCursor(range(meta.userId));
  let visited = 0;
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor || visited >= budget) { done(); return; }
    const over = meta.count + (extra ? 1 : 0) > MAX_BATCHES || meta.bytes + (extra?.bytes ?? 0) > MAX_BYTES;
    const createdAt = (cursor.key as [string, number, string])[1];
    if (createdAt >= Date.now() - MAX_AGE_MS && !over) { done(); return; }
    const row = cursor.value as StoredBatch;
    cursor.delete();
    subtract(meta, row);
    meta.lost += row.eventCount;
    visited++;
    cursor.continue();
  };
}

export class PlaybackTraceOutbox {
  private db: Promise<IDBDatabase> | null = null;
  private memory = new Map<string, StoredBatch>();
  private fallback = false;
  private memoryBytes = 0;
  private memoryTail: StoredBatch | undefined;
  private persistentLost = 0;
  private volatileLost = 0;
  get lost(): number { return this.persistentLost + this.volatileLost; }
  get volatile(): boolean { return this.fallback; }
  constructor(private userId: string) {}

  private open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    let blocked = false;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('soundsible-playback-traces', 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        const store = db.objectStoreNames.contains('batches')
          ? request.transaction!.objectStore('batches')
          : db.createObjectStore('batches', { keyPath: 'id' });
        store.createIndex('accountDate', ['userId', 'createdAt', 'id']);
        const accounts = db.createObjectStore('accounts', { keyPath: 'userId' });
        // One-time v1 migration: convert one row at a time, never getAll().
        const totals = new Map<string, Account>();
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (item) {
            const row = stored(item.value as TraceBatch);
            const meta = totals.get(row.userId) ?? account(row.userId);
            meta.count++;
            meta.bytes += row.bytes;
            totals.set(row.userId, meta);
            item.update(row);
            item.continue();
          } else {
            for (const meta of totals.values()) {
              // Enforce the new quota before exposing a migrated database.
              trim(store, meta, undefined, Infinity, () => accounts.put(meta));
            }
          }
        };
      };
      request.onsuccess = () => {
        if (blocked) { request.result.close(); this.db = null; return; }
        const db = request.result;
        db.onversionchange = () => { db.close(); this.db = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => { blocked = true; reject(new Error('trace_storage_blocked')); };
    });
    this.db = opening;
    void opening.catch(() => { if (!blocked && this.db === opening) this.db = null; });
    return opening;
  }

  private async transaction<T>(mode: IDBTransactionMode,
    action: (store: IDBObjectStore, accounts: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['batches', 'accounts'], mode);
      let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      try { action(tx.objectStore('batches'), tx.objectStore('accounts'), value => { result = value; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  }

  private pruneMemory(): void {
    for (const [id, row] of this.memory) {
      if (row.createdAt >= Date.now() - MAX_AGE_MS && this.memory.size <= MAX_BATCHES && this.memoryBytes <= MAX_BYTES) break;
      this.memory.delete(id);
      this.memoryBytes -= row.bytes;
      this.volatileLost += row.eventCount;
    }
    if (!this.memory.size) this.memoryTail = undefined;
  }

  async put(batch: TraceBatch): Promise<void> {
    if (batch.userId !== this.userId) throw new Error('trace_account_mismatch');
    const row = stored(batch);
    try {
      const lost = await this.transaction<number>('readwrite', (store, accounts, done) => {
        const getMeta = accounts.get(this.userId);
        getMeta.onsuccess = () => {
          const meta: Account = getMeta.result ?? account(this.userId);
          const getOld = store.get(row.id);
          getOld.onsuccess = () => {
            const old = getOld.result as StoredBatch | undefined;
            if (old && old.userId !== this.userId) { done(meta.lost); return; }
            if (old) { subtract(meta, old); store.delete(old.id); }
            const finish = () => { accounts.put(meta); done(meta.lost); };
            if (row.bytes > MAX_BYTES || row.createdAt < Date.now() - MAX_AGE_MS) {
              meta.lost += row.eventCount;
              finish();
              return;
            }
            trim(store, meta, row, MAINTENANCE_ROWS, () => {
              if (meta.count >= MAX_BATCHES || meta.bytes + row.bytes > MAX_BYTES) {
                // A huge admission must not turn one transaction into a scan.
                meta.lost += row.eventCount;
              } else {
                store.put(row);
                meta.count++;
                meta.bytes += row.bytes;
              }
              finish();
            });
          };
        };
      });
      this.persistentLost = Math.max(this.persistentLost, lost);
      const previous = this.memory.get(batch.id);
      if (previous) {
        this.memoryBytes -= previous.bytes;
        this.memory.delete(batch.id);
        if (this.memoryTail?.id === batch.id) this.memoryTail = undefined;
      }
    } catch {
      this.fallback = true;
      const previous = this.memory.get(row.id);
      this.memoryBytes -= previous?.bytes ?? 0;
      if (!this.memoryTail) {
        for (const value of this.memory.values()) this.memoryTail = value;
      }
      this.memory.delete(row.id);
      this.memory.set(row.id, row);
      this.memoryBytes += row.bytes;
      // Normal recording appends in time order. Only late/replaced batches
      // need to reorder metadata; sending never sorts the whole backlog.
      const tail = this.memoryTail;
      if (tail && (row.createdAt < tail.createdAt || (row.createdAt === tail.createdAt && row.id.localeCompare(tail.id) < 0))) {
        this.memory = new Map([...this.memory].sort((a, b) =>
          a[1].createdAt - b[1].createdAt || a[0].localeCompare(b[0])));
        this.memoryTail = [...this.memory.values()].at(-1);
      } else this.memoryTail = row;
      this.pruneMemory();
    }
  }

  /** Separate bounded maintenance, including while delivery is backing off. */
  async maintain(): Promise<void> {
    this.pruneMemory();
    try {
      const lost = await this.transaction<number>('readwrite', (store, accounts, done) => {
        const request = accounts.get(this.userId);
        request.onsuccess = () => {
          const meta: Account | undefined = request.result;
          if (!meta || !meta.count) { done(meta?.lost ?? 0); return; }
          const before = meta.count;
          trim(store, meta, undefined, MAINTENANCE_ROWS, () => {
            if (meta.count !== before) accounts.put(meta);
            done(meta.lost);
          });
        };
      });
      this.persistentLost = Math.max(this.persistentLost, lost);
    } catch { this.fallback = true; }
  }

  /** Read only one upload window, in account/date/id order. No retention scan. */
  async pending(): Promise<TraceBatch[]> {
    this.pruneMemory();
    let rows: StoredBatch[] = [];
    try {
      rows = await this.transaction<StoredBatch[]>('readonly', (store, accounts, done) => {
        const meta = accounts.get(this.userId);
        meta.onsuccess = () => { this.persistentLost = Math.max(this.persistentLost, meta.result?.lost ?? 0); };
        const result: StoredBatch[] = [];
        const request = store.index('accountDate').openCursor(range(this.userId, Date.now() - MAX_AGE_MS));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || result.length === SEND_BATCHES) { done(result); return; }
          result.push(cursor.value as StoredBatch);
          if (result.length === SEND_BATCHES) done(result);
          else cursor.continue();
        };
      });
    } catch { this.fallback = true; }
    const unique = new Map(rows.map(row => [row.id, row]));
    let count = 0;
    for (const [id, row] of this.memory) {
      unique.set(id, row);
      if (++count === SEND_BATCHES) break;
    }
    return [...unique.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .slice(0, SEND_BATCHES).map(row => ({ ...row.batch, dropped: row.batch.dropped + this.lost }));
  }

  async remove(id: string): Promise<void> {
    // A failed delete remains safe: the server acknowledges this same ID again.
    try {
      await this.transaction<void>('readwrite', (store, accounts, done) => {
        const getRow = store.get(id);
        getRow.onsuccess = () => {
          const row = getRow.result as StoredBatch | undefined;
          if (!row || row.userId !== this.userId) { done(); return; }
          const getMeta = accounts.get(this.userId);
          getMeta.onsuccess = () => {
            const meta: Account = getMeta.result ?? account(this.userId);
            subtract(meta, row);
            accounts.put(meta);
            store.delete(id);
            done();
          };
        };
      });
    } catch { /* retry later */ }
    const row = this.memory.get(id);
    if (row) this.memoryBytes -= row.bytes;
    this.memory.delete(id);
    if (this.memoryTail?.id === id) this.memoryTail = undefined;
  }

  /** Purge an account after the server disables capture, in bounded transactions. */
  async clear(): Promise<void> {
    this.memory.clear();
    this.memoryBytes = 0;
    this.memoryTail = undefined;
    try {
      let more = true;
      while (more) {
        more = await this.transaction<boolean>('readwrite', (store, accounts, done) => {
          const getMeta = accounts.get(this.userId);
          getMeta.onsuccess = () => {
            const meta: Account = getMeta.result ?? account(this.userId);
            const request = store.index('accountDate').openCursor(range(this.userId));
            let removed = 0;
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor || removed === MAINTENANCE_ROWS) {
                accounts.put(meta); done(!!cursor); return;
              }
              subtract(meta, cursor.value as StoredBatch);
              cursor.delete();
              removed++;
              cursor.continue();
            };
          };
        });
      }
    } catch { this.fallback = true; }
  }
}
