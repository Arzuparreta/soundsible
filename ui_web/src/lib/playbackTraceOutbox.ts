/** Acknowledged batches survive reloads and offline trips, separately per account. */
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
export class PlaybackTraceOutbox {
  private db: Promise<IDBDatabase> | null = null;
  private memory = new Map<string, TraceBatch>();
  private fallback = false;
  private memoryBytes = 0;
  lost = 0;
  get volatile(): boolean { return this.fallback; }
  constructor(private userId: string) {}

  private open(): Promise<IDBDatabase> {
    return this.db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('soundsible-playback-traces', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('batches', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('trace_storage_blocked'));
    });
  }
  private async transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('batches', mode);
      const request = action(tx.objectStore('batches'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  async put(batch: TraceBatch): Promise<void> {
    try { await this.transaction('readwrite', (s) => s.put(batch)); }
    catch {
      this.fallback = true;
      this.memoryBytes -= this.memory.has(batch.id) ? JSON.stringify(this.memory.get(batch.id)).length : 0;
      this.memory.set(batch.id, batch);
      this.memoryBytes += JSON.stringify(batch).length;
      while (this.memory.size > MAX_BATCHES || this.memoryBytes > MAX_BYTES) {
        const first = this.memory.keys().next().value!;
        this.lost += this.memory.get(first)!.events.length;
        this.memoryBytes -= JSON.stringify(this.memory.get(first)).length;
        this.memory.delete(first);
      }
    }
  }
  async pending(): Promise<TraceBatch[]> {
    let rows: TraceBatch[] = [];
    try { rows = await this.transaction('readonly', (s) => s.getAll()); }
    catch { this.fallback = true; }
    const unique = new Map(rows.filter((b) => b.userId === this.userId).map((b) => [b.id, b]));
    for (const [id, batch] of this.memory) unique.set(id, batch);
    rows = [...unique.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    let bytes = rows.reduce((total, batch) => total + JSON.stringify(batch).length, 0);
    const expired = rows.filter((b, index) => {
      if (b.createdAt < Date.now() - MAX_AGE_MS || index < rows.length - MAX_BATCHES || bytes > MAX_BYTES) {
        bytes -= JSON.stringify(b).length;
        return true;
      }
      return false;
    });
    for (const batch of expired) { this.lost += batch.events.length; await this.remove(batch.id); }
    const removed = new Set(expired.map((b) => b.id));
    return rows.filter((b) => !removed.has(b.id));
  }
  async remove(id: string): Promise<void> {
    // If deletion fails the server safely acknowledges this id again next time.
    try { await this.transaction('readwrite', (s) => s.delete(id)); } catch { /* retry later */ }
    this.memoryBytes -= this.memory.has(id) ? JSON.stringify(this.memory.get(id)).length : 0;
    this.memory.delete(id);
  }
}
