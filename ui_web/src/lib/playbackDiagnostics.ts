/** Opt-in, memory-only flight recorder. Never records URLs, titles or audio. */
export type RetirementVariant = 'reference' | 'delayed' | 'excluded';
export interface DiagnosticSetup {
  variant: RetirementVariant;
  ios: string;
  connection: 'bluetooth' | 'carplay' | 'other';
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
const nodes = new Map<string, HTMLMediaElement>();
const deckIndexes = new WeakMap<HTMLMediaElement, number>();
const ids = new WeakMap<HTMLMediaElement, string>();
const buffer: Array<ReturnType<typeof entry>> = [];
let snapshot: (() => Facts) | null = null;

export function setDiagnosticSnapshot(reader: () => Facts): void { snapshot = reader; }
export function retirementVariant(): RetirementVariant { return active ? setup!.variant : 'reference'; }
export function diagnosticStatus() { return { active, setup, retained: buffer.length, dropped }; }

export function startPlaybackDiagnostics(options: DiagnosticSetup): void {
  if (active) throw new Error('diagnostic_already_active');
  if (!/^\d+(?:\.\d+){0,3}$/.test(options.ios.trim())) throw new Error('ios_version_required');
  setup = { ...options, ios: options.ios.trim(), id: crypto.randomUUID(), startedAt: new Date().toISOString(),
    clientRevision: typeof __PLAYBACK_SOURCE_REVISION__ === 'string' ? __PLAYBACK_SOURCE_REVISION__ : 'test-unverified' };
  start = performance.now();
  sequence = 0;
  dropped = 0;
  buffer.length = 0;
  cursor = 0;
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
      errorCode: element.error?.code ?? 0,
    })),
  };
}

/** Recording must never alter a transport operation or throw into a handler. */
export function recordPlaybackDiagnostic(event: string, facts: Facts = {}): void {
  if (!active) return;
  try {
    const row = entry(event, facts);
    if (buffer.length === CAPACITY) {
      buffer[cursor] = row;
      cursor = (cursor + 1) % CAPACITY;
      dropped++;
    } else buffer.push(row);
  } catch { dropped++; }
}

export function playbackDiagnosticExport(): string {
  return JSON.stringify({ setup, active, dropped, retained: buffer.length,
    clock: 'client monotonic milliseconds from capture start; startedAt is client wall time',
    observation: 'Declared browser state is not the effective iOS or car state. Markers are human reports at recording time.',
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
  const listener = (event: Event) => recordPlaybackDiagnostic(`media.${event.type}`, { node: id });
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
