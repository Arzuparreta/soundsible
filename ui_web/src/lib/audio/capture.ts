import type { RuntimeLifetime } from '../runtimeLifetime';
import type { BroadcastCapture, ProgramPlaybackSnapshot, CapturableAudioElement } from "./contracts";
export interface CapturePorts {
  programPlaybackSnapshot: () => ProgramPlaybackSnapshot;
  programOutput: AudioNode | null;
  graphReady: () => boolean;
  audioContext: AudioContext | null;
  audioEl: () => HTMLAudioElement;
}

/** Owns the capture resources of the page's audio service. */
export function createCapture(ports: CapturePorts, _lifetime: RuntimeLifetime) {
  let broadcastDestination: MediaStreamAudioDestinationNode | null = null;
  let broadcastCapture: BroadcastCapture | null = null;
  let broadcastElement: HTMLAudioElement | null = null;
  let broadcastCaptureCleanup: (() => void) | null = null;
  let broadcastLostReporter: (() => void) | null = null;
  function setBroadcastLostReporter(fn: (() => void) | null): void {
    broadcastLostReporter = fn;
  }
  function activeAudioTrack(stream: MediaStream): MediaStreamTrack | null {
    return stream.getAudioTracks().find(track => track.readyState !== 'ended') ?? null;
  }
  function broadcastPlaybackActive(): boolean {
    return ports.programPlaybackSnapshot().playing;
  }
  function releaseBroadcastCapture(): void {
    const capture = broadcastCapture;
    broadcastCapture = null;
    broadcastElement = null;
    const cleanup = broadcastCaptureCleanup;
    broadcastCaptureCleanup = null;
    cleanup?.();
    if (!capture) return;
    if (capture.kind === 'program' && broadcastDestination) {
      try {
        ports.programOutput?.disconnect(broadcastDestination);
      } catch {
        /* the graph was already torn down */
      }
      broadcastDestination = null;
    }
    for (const track of capture.stream.getTracks()) track.stop();
  }
  function programBroadcastCapture(): BroadcastCapture | null {
    if (!ports.graphReady() || !ports.audioContext || !ports.programOutput) return null;
    if (broadcastCapture?.kind === 'program') return broadcastCapture;
    releaseBroadcastCapture();
    if (typeof ports.audioContext.createMediaStreamDestination !== 'function') return null;
    broadcastDestination = ports.audioContext.createMediaStreamDestination();
    ports.programOutput.connect(broadcastDestination);
    const track = activeAudioTrack(broadcastDestination.stream);
    if (track && 'contentHint' in track) track.contentHint = 'music';
    const stream = broadcastDestination.stream;
    broadcastCapture = {
      kind: 'program',
      stream,
      onTrackChange: () => () => {}
    };
    return broadcastCapture;
  }
  function elementBroadcastCapture(element: HTMLAudioElement): BroadcastCapture | null {
    if (broadcastCapture?.kind === 'element' && broadcastElement === element) return broadcastCapture;
    releaseBroadcastCapture();
    const capture = (element as CapturableAudioElement).captureStream ?? (element as CapturableAudioElement).mozCaptureStream;
    if (!capture) return null;
    let stream: MediaStream;
    try {
      stream = capture.call(element);
    } catch {
      return null;
    }
    const listeners = new Set<(track: MediaStreamTrack | null) => void>();
    let observedTrack: MediaStreamTrack | null = null;
    const observeTrack = () => {
      const next = activeAudioTrack(stream);
      if (next === observedTrack) return;
      if (observedTrack && typeof observedTrack.removeEventListener === 'function') {
        observedTrack.removeEventListener('ended', notify);
      }
      observedTrack = next;
      if (observedTrack && typeof observedTrack.addEventListener === 'function') {
        observedTrack.addEventListener('ended', notify);
      }
    };
    const notify = () => {
      observeTrack();
      const track = activeAudioTrack(stream);
      for (const listener of listeners) listener(track);
    };
    stream.addEventListener('addtrack', notify);
    stream.addEventListener('removetrack', notify);
    observeTrack();
    broadcastCaptureCleanup = () => {
      stream.removeEventListener('addtrack', notify);
      stream.removeEventListener('removetrack', notify);
      if (observedTrack && typeof observedTrack.removeEventListener === 'function') {
        observedTrack.removeEventListener('ended', notify);
      }
      listeners.clear();
    };
    broadcastElement = element;
    broadcastCapture = {
      kind: 'element',
      stream,
      onTrackChange: listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    };
    return broadcastCapture;
  }
  function acquireBroadcastCapture(): BroadcastCapture | null {
    const program = programBroadcastCapture();
    if (program) return program;
    const element = ports.audioEl();
    if (!element.currentSrc && !element.getAttribute('src')) return null;
    const fallback = elementBroadcastCapture(element);
    return fallback && activeAudioTrack(fallback.stream) ? fallback : null;
  }
  function broadcastStream(): MediaStream | null {
    return acquireBroadcastCapture()?.stream ?? null;
  }
  function releaseBroadcastStream(): void {
    releaseBroadcastCapture();
  }
  const actions = {
    acquireBroadcastCapture,
    broadcastPlaybackActive,
    broadcastStream,
    releaseBroadcastStream
  };
  return {
    dispose() {
      releaseBroadcastCapture();
      broadcastLostReporter = null;
    },
    actions,
    get broadcastCapture() {
      return broadcastCapture;
    },
    set broadcastCapture(value: BroadcastCapture | null) {
      broadcastCapture = value;
    },
    releaseBroadcastCapture,
    get broadcastLostReporter() {
      return broadcastLostReporter;
    },
    set broadcastLostReporter(value: (() => void) | null) {
      broadcastLostReporter = value;
    },
    setBroadcastLostReporter,
    broadcastPlaybackActive,
    acquireBroadcastCapture,
    broadcastStream,
    releaseBroadcastStream
  };
}
