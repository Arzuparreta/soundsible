/**
 * How fast the music is actually arriving, and whether that is fast enough.
 *
 * A listener whose station is a room away and one whose station is behind a
 * relay see the same screen today: "Buffering…", for as long as it takes. The
 * engine knows the difference — it measures what it delivers — so the player
 * can say it: 0.7 Mbps against a track that needs 1.5 is not a mystery, it is
 * an answer.
 *
 * Nothing here probes the network. The reading comes from the audio the
 * listener already asked for (see `shared/link_quality.py`), so asking costs
 * one small request and never competes with playback for bandwidth.
 */

import { createSignal } from 'solid-js';
import { api } from './api';
import type { Track } from '../types/music';

export type LinkScope = 'local' | 'lan' | 'tailnet' | 'remote';

export interface LinkReading {
  /** Where the engine sees this client from. Never whether Tailscale relayed:
   * the engine cannot see that, and a diagnostic that guesses is the problem
   * this exists to fix. */
  scope: LinkScope | null;
  /** Best recent measurement, or null when nothing measurable has been served. */
  kbps: number | null;
  samples: number;
  measured_at: number | null;
}

/** How much headroom a link needs over a track's own bitrate before playing it
 * straight through is a reasonable bet. Ranges, headers and re-reads all cost
 * more than the audio itself, and a link at exactly 1.0x stalls forever. */
export const HEADROOM = 1.5;

/** Long enough that a stalling track does not ask on every `waiting` event,
 * short enough that walking out of the house shows up. */
const REFRESH_MS = 20_000;

const [reading, setReading] = createSignal<LinkReading | null>(null);
let lastAsked = 0;
let inFlight: Promise<void> | null = null;

/** The last reading, or null. Reactive: read it inside a tracking scope. */
export const linkReading = reading;

/** What this track needs, in kbps, or null when the engine never said.
 *
 * Measured from the file rather than taken from `bitrate`, because `bitrate` is
 * what the encoder was asked for and the file is what has to cross the network
 * — on a 24-bit FLAC the two differ by a lot.
 */
export function trackKbps(track: Track | null | undefined): number | null {
  if (!track) return null;
  const size = track.file_size;
  const duration = track.duration;
  if (size && duration && duration > 0) return (size * 8) / duration / 1000;
  return track.bitrate && track.bitrate > 0 ? track.bitrate : null;
}

/**
 * Can this link carry this track as it plays?
 *
 * `null` means "not measured", which is a different answer from "no" and must
 * stay different: a player that reports a slow link before it has measured one
 * is lying in the other direction.
 */
export function linkFits(current: LinkReading | null, track: Track | null | undefined): boolean | null {
  const needed = trackKbps(track);
  if (!current?.kbps || !needed) return null;
  return current.kbps >= needed * HEADROOM;
}

/** Mbps, at one decimal — the unit people read speeds in. */
export function mbps(kbps: number): string {
  return (kbps / 1000).toFixed(1);
}

/** Ask the engine for its reading, at most once every `REFRESH_MS`.
 *
 * Failures are swallowed: a diagnostic that breaks playback would be worse than
 * the silence it replaces.
 */
export function refreshLinkReading(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastAsked < REFRESH_MS) return inFlight ?? Promise.resolve();
  lastAsked = now;
  inFlight = api
    .getLinkQuality()
    .then((next) => {
      setReading(next);
    })
    .catch(() => {
      /* an engine that cannot answer is not a reason to change the screen */
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Forget everything measured. For tests, and for switching account. */
export function resetLinkReading(): void {
  setReading(null);
  lastAsked = 0;
  inFlight = null;
}
