export interface DiscoveryFeedReadyEvent {
  limit?: number;
  generated_at?: number;
  browse_error?: boolean;
  error?: boolean;
}

type DiscoveryFeedReadyListener = (data: DiscoveryFeedReadyEvent) => void;

const listeners = new Set<DiscoveryFeedReadyListener>();

/** Subscribe to server-pushed discovery feed completions across web and mobile runtimes. */
export function onDiscoveryFeedReady(handler: DiscoveryFeedReadyListener): () => void {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}

export function dispatchDiscoveryFeedReady(data: DiscoveryFeedReadyEvent = {}): void {
  for (const listener of [...listeners]) {
    listener(data);
  }
}
