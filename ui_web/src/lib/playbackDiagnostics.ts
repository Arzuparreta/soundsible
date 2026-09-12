/** Passive flight recorder. Native transport calls retain their original behavior. */
import { PlaybackTraceOutbox, type TraceBatch } from './playbackTraceOutbox';
export interface DiagnosticSetup {
  userId: string;
  deviceId: string;
  platform: string;
  displayMode: string;
}
type Facts = Record<string, string | number | boolean | null>;
const CAPACITY = 4096;
let setup: (DiagnosticSetup & { id: string; startedAt: string; clientRevision: string }) | null = null;
let active = false;
let sequence = 0;
let dropped = 0;
let start = 0;
let operation = 0;
let nodeSequence = 0;
let cursor = 0;
let ringDiscarded = 0;
let denseUntil = 0;
const nodes = new Map<string, HTMLMediaElement>();
const deckIndexes = new WeakMap<HTMLMediaElement, number>();
const ids = new WeakMap<HTMLMediaElement, string>();
const buffer: Array<ReturnType<typeof entry>> = [];
let snapshot: (() => Facts) | null = null;

export function setDiagnosticSnapshot(reader: () => Facts): void { snapshot = reader; }
export function diagnosticStatus() { return { active, setup, retained: buffer.length, dropped }; }

export function startPlaybackDiagnostics(options: DiagnosticSetup): void {
  if (active) throw new Error('diagnostic_already_active');
  setup = { ...options, id: globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`, startedAt: new Date().toISOString(),
    clientRevision: typeof __PLAYBACK_SOURCE_REVISION__ === 'string' ? __PLAYBACK_SOURCE_REVISION__ : 'test-unverified' };
  start = performance.now();
  sequence = 0;
  dropped = 0;
  buffer.length = 0;
  cursor = 0;
  ringDiscarded = 0;
  active = true;
  recordPlaybackDiagnostic('capture.start');
}

export function stopPlaybackDiagnostics(): void {
  recordPlaybackDiagnostic('capture.stop');
  active = false;
}

function entry(event: string, facts: Facts) {
  return {
    sequence: ++sequence, elapsedMs: performance.now() - start, event, facts,
    declaredState: typeof navigator !== 'undefined' && 'mediaSession' in navigator
      ? navigator.mediaSession.playbackState : 'unsupported',
    visibility: document.visibilityState,
    program: snapshot?.() ?? {},
    media: Array.from(nodes, ([id, element]) => ({
      id, deckIndex: deckIndexes.get(element) ?? null, paused: element.paused, ended: element.ended, muted: element.muted,
      position: Number.isFinite(element.currentTime) ? element.currentTime : null,
      duration: Number.isFinite(element.duration) ? element.duration : null,
      rate: element.playbackRate, volume: element.volume,
      readyState: element.readyState, networkState: element.networkState,
      hasSource: Boolean(element.srcObject || element.getAttribute('src') || element.currentSrc),
      sourceKind: element.srcObject ? 'stream' : (element.getAttribute('src') ?? '').startsWith('data:audio/wav')
        ? 'unlock_sample' : element.getAttribute('src') || element.currentSrc ? 'track' : 'empty',
      errorCode: element.error?.code ?? 0,
    })),
  };
}

/** Recording must never alter a transport operation or throw into a handler. */
export function recordPlaybackDiagnostic(event: string, facts: Facts = {}): void {
  if (!active) return;
  try {
    if (event === 'handoff.retirement' || String(facts.reason ?? '').startsWith('handoff')) denseUntil = performance.now() + 10_000;
    const row = entry(event, facts);
    if (buffer.length === CAPACITY) {
      buffer[cursor] = row;
      cursor = (cursor + 1) % CAPACITY;
      ringDiscarded++;
    } else buffer.push(row);
    collect?.(row);
  } catch { dropped++; }
}

export function playbackDiagnosticExport(): string {
  return JSON.stringify({ setup, active, dropped, ringDiscarded, retained: buffer.length,
    clock: 'client monotonic milliseconds from capture start; startedAt is client wall time',
    observation: 'Declared browser state is not the effective iOS or car state.',
    events: [...buffer.slice(cursor), ...buffer.slice(0, cursor)] }, null, 2);
}

/** Observe before store filters, without patching browser prototypes. */
export function observeDiagnosticMedia(element: HTMLMediaElement, role: 'deck' | 'carrier', deckIndex?: number): () => void {
  const id = `${role}-${++nodeSequence}`;
  ids.set(element, id);
  nodes.set(id, element);
  if (deckIndex !== undefined) deckIndexes.set(element, deckIndex);
  const events = ['play', 'playing', 'pause', 'ended', 'emptied', 'loadstart', 'loadedmetadata',
    'durationchange', 'waiting', 'stalled', 'canplay', 'error', 'seeking', 'seeked', 'ratechange', 'volumechange', 'timeupdate'];
  let lastSample = -Infinity;
  const listener = (event: Event) => {
    if (event.type === 'timeupdate') {
      const now = performance.now();
      if (now - lastSample < (now < denseUntil ? 250 : 5000)) return;
      lastSample = now;
    }
    recordPlaybackDiagnostic(`media.${event.type}`, { node: id });
  };
  for (const event of events) element.addEventListener(event, listener);
  return () => {
    nodes.delete(id);
    for (const event of events) element.removeEventListener(event, listener);
  };
}

export function diagnosticPlay(element: HTMLMediaElement): Promise<void> {
  if (!active) return element.play();
  const id = ids.get(element) ?? 'unknown';
  const capture = setup!.id;
  const op = ++operation;
  recordPlaybackDiagnostic('call.play', { node: id, operation: op });
  try {
    const promise = element.play();
    recordPlaybackDiagnostic('return.play', { node: id, operation: op });
    void promise.then(() => {
      if (setup?.id === capture) recordPlaybackDiagnostic('resolve.play', { node: id, operation: op });
    }, (error: unknown) => {
      if (setup?.id === capture) recordPlaybackDiagnostic('reject.play', {
        node: id, operation: op, error: error instanceof DOMException ? error.name : 'Error',
      });
    });
    return promise;
  } catch (error) {
    recordPlaybackDiagnostic('throw.play', { node: id, operation: op });
    throw error;
  }
}

export function diagnosticPause(element: HTMLMediaElement): void {
  const id = ids.get(element) ?? 'unknown';
  recordPlaybackDiagnostic('call.pause', { node: id });
  element.pause();
  recordPlaybackDiagnostic('return.pause', { node: id });
}

export function diagnosticLoad(element: HTMLMediaElement): void {
  const id = ids.get(element) ?? 'unknown';
  recordPlaybackDiagnostic('call.load', { node: id });
  element.load();
  recordPlaybackDiagnostic('return.load', { node: id });
}

export function diagnosticSource(element: HTMLMediaElement, change: () => void): void {
  recordPlaybackDiagnostic('source.before', { node: ids.get(element) ?? 'unknown' });
  change();
  recordPlaybackDiagnostic('source.after', { node: ids.get(element) ?? 'unknown' });
}


let collect: ((row: ReturnType<typeof entry>) => void) | null = null;
let stopAutomatic: (() => void) | null = null;

/** Called after authentication, before installing audio unlock or restoring playback. */
export function startAutomaticPlaybackDiagnostics(options: DiagnosticSetup, send: (batch: TraceBatch) => Promise<{ id: string; enabled: boolean }>,
  stillSameUser: () => boolean = () => true): () => void {
  if (stopAutomatic) return stopAutomatic;
  const outbox = new PlaybackTraceOutbox(options.userId);
  let pending: Array<ReturnType<typeof entry>> = [];
  let pendingSize = 2; // JSON array brackets, then one comma between rows.
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let chain = Promise.resolve();
  let busy = false;
  let stopped = false;
  let retryAt = 0;
  let failures = 0;
  const persist = () => {
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = null;
    if (!pending.length || !setup) return;
    const rows = pending;
    pending = [];
    pendingSize = 2;
    const batch: TraceBatch = { id: `${setup.id}:${rows[0].sequence}`, userId: options.userId,
      createdAt: Date.now(), capture: { ...setup }, dropped: dropped + outbox.lost, events: rows };
    chain = chain.then(() => outbox.put(batch));
  };
  const flush = async () => {
    persist();
    if (busy || stopped || !stillSameUser()) return;
    busy = true;
    try {
      await chain;
      const batches = await outbox.pending();
      if (Date.now() < retryAt) return;
      // Persisting once per second can create five batches between sends.
      // Drain more than that so an offline backlog shrinks during playback.
      for (const batch of batches.slice(0, 6)) {
        if (stopped || !stillSameUser()) break;
        const ack = await send(batch);
        if (ack.id !== batch.id) throw new Error('trace_ack_mismatch');
        await outbox.remove(batch.id);
        failures = 0;
        if (!ack.enabled) {
          pending = [];
          stop();
          await chain;
          for (const remaining of await outbox.pending()) await outbox.remove(remaining.id);
          break;
        }
      }
    } catch {
      retryAt = Date.now() + Math.min(60_000, 5000 * 2 ** Math.min(++failures, 4));
    } finally { busy = false; }
  };
  collect = (row) => {
    if (!stillSameUser() || stopped) return;
    // A batch stays below the browser keepalive and server body limits.
    const rowSize = JSON.stringify(row).length;
    if (pending.length && pendingSize + 1 + rowSize > 40_000) persist();
    pendingSize += rowSize + (pending.length ? 1 : 0);
    pending.push(row);
    if (pending.length >= 24) persist();
    else if (persistTimer === null) persistTimer = setTimeout(persist, 1000);
  };
  const lifecycle = () => {
    recordPlaybackDiagnostic('capture.lifecycle', { persisted: !outbox.volatile, lost: outbox.lost });
    void flush();
  };
  const online = () => { retryAt = 0; void flush(); };
  const timer = setInterval(() => { void flush(); }, 5000);
  const stop = () => {
    if (stopped) return;
    persist();
    stopped = true;
    collect = null;
    stopPlaybackDiagnostics();
    clearInterval(timer);
    window.removeEventListener('pagehide', lifecycle);
    window.removeEventListener('online', online);
    document.removeEventListener('visibilitychange', lifecycle);
    stopAutomatic = null;
  };
  stopAutomatic = stop;
  window.addEventListener('pagehide', lifecycle);
  window.addEventListener('online', online);
  document.addEventListener('visibilitychange', lifecycle);
  startPlaybackDiagnostics(options);
  void flush();
  return stop;
}
