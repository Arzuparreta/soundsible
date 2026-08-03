import { createEffect, onCleanup, onMount } from 'solid-js';
import { state } from '../stores';
import {
  acquireBroadcastCapture,
  broadcastPlaybackActive,
  programMixSnapshot,
  releaseBroadcastStream,
  setBroadcastLostReporter,
  type BroadcastCapture,
} from '../lib/audio';
import {
  hostSession,
  publisherConnected,
  replaceHostPublisherTrack,
  reportBroadcastLost,
  resumeCommunityIfActive,
  sendProgramEvent,
  startHostPublisher,
  uploadHostArtwork,
  type LiveDeck,
  type LiveProgram,
} from '../lib/community';
import type { Track } from '../types/music';
import { coverUrl } from '../lib/media';

/** How often a paused room repeats itself. Playing rooms emit every tick. */
const PAUSED_HEARTBEAT_MS = 5000;
/** A source being loaded can briefly have no capturable track. Past this it is
 * a real, actionable failure, not a room that pretends it is about to start. */
const CAPTURE_WAIT_MS = 2000;

const artworkUrls = new Map<string, string>();
const artworkPending = new Set<string>();
const publicTrackIds = new Map<string, string>();

function publicArtwork(track: Track | null): string | null {
  if (track && artworkUrls.has(track.id)) return artworkUrls.get(track.id)!;
  return null;
}

function publicTrackId(track: Track): string {
  const known = publicTrackIds.get(track.id);
  if (known) return known;
  const next = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, '0')).join('');
  publicTrackIds.set(track.id, next);
  return next;
}

function ensureArtwork(track: Track | null): void {
  if (!track || artworkUrls.has(track.id) || artworkPending.has(track.id)) return;
  artworkPending.add(track.id);
  void uploadHostArtwork(track.id, coverUrl(track.id))
    .then((url) => {
      if (url) artworkUrls.set(track.id, url);
    })
    .finally(() => artworkPending.delete(track.id));
}

function deck(track: Track | null, position: number, duration: number, gain: number): LiveDeck | null {
  if (!track) return null;
  return {
    id: publicTrackId(track),
    title: track.title,
    artist: track.artist,
    artwork_url: publicArtwork(track),
    position,
    duration: duration || track.duration || 0,
    gain,
  };
}

/**
 * Headless bridge mounted once with the shell. It follows the real player bus
 * across routes, Now Playing and Auto without making Community another mode.
 */
export function CommunityBridge() {
  let timer: number | undefined;
  let seq = 0;
  let previousTrack: Track | null = null;
  let lastTrack: Track | null = null;
  let publishing = false;
  let wasPlaying = false;
  let pausedSince: number | null = null;
  let lastEmit = 0;
  let capture: BroadcastCapture | null = null;
  let stopTrackWatch: (() => void) | null = null;
  let captureMissingSince: number | null = null;
  let reportedMissingCapture = false;

  const resetCapture = () => {
    stopTrackWatch?.();
    stopTrackWatch = null;
    capture = null;
  };

  const watchCapture = (next: BroadcastCapture) => {
    if (capture === next) return;
    resetCapture();
    capture = next;
    stopTrackWatch = next.onTrackChange((track) => {
      if (capture !== next || !track) return;
      void replaceHostPublisherTrack(next.stream).catch(() => {
        publishing = false;
      });
    });
  };

  onMount(() => {
    setBroadcastLostReporter(() => {
      publishing = false;
      resetCapture();
      reportBroadcastLost();
    });
    void resumeCommunityIfActive();
    timer = window.setInterval(() => {
      const session = hostSession();
      if (!session) return;
      const current = state.playback.currentTrack;
      const mix = programMixSnapshot();
      if (lastTrack && current && lastTrack.id !== current.id && mix.phase !== 'idle') {
        previousTrack = lastTrack;
      }
      if (current) lastTrack = current;
      ensureArtwork(current);

      // The media element, not a route-local playback flag, is authoritative.
      // That makes starting Live equally reliable from Music, Auto, podcasts,
      // Now Playing, and a player that was already running before Live opened.
      const playing = broadcastPlaybackActive();
      const nextCapture = playing ? acquireBroadcastCapture() : null;
      if (nextCapture) {
        captureMissingSince = null;
        reportedMissingCapture = false;
        watchCapture(nextCapture);
      } else if (playing) {
        captureMissingSince ??= Date.now();
        if (!reportedMissingCapture && Date.now() - captureMissingSince >= CAPTURE_WAIT_MS) {
          reportedMissingCapture = true;
          reportBroadcastLost();
        }
      } else {
        captureMissingSince = null;
        reportedMissingCapture = false;
      }

      if (playing && nextCapture && !publishing) {
        publishing = true;
        void startHostPublisher(nextCapture.stream).catch(() => {
          publishing = false;
        });
      }
      if (!publisherConnected()) return;
      const now = Date.now();
      if (playing) {
        pausedSince = null;
      } else {
        pausedSince ??= now;
        // A break needs a pulse, not a stream: enough for the directory and for
        // whoever walks in mid-silence to see the room is resting, not broken.
        if (!wasPlaying && now - lastEmit < PAUSED_HEARTBEAT_MS) return;
      }

      const active = mix.decks.find((item) => item.index === mix.activeIndex);
      const other = mix.decks.find((item) => item.index !== mix.activeIndex);
      const next = state.playback.queue[state.playback.index + 1] ?? null;
      const secondaryTrack = !playing || mix.phase === 'idle'
        ? null
        : mix.dominant
          ? previousTrack
          : next;
      ensureArtwork(secondaryTrack);
      const payload: LiveProgram = {
        v: 1,
        seq: seq++,
        emitted_at: now,
        program_time: mix.contextTime,
        transport: playing ? 'playing' : 'paused',
        paused_since: pausedSince,
        primary: deck(current, active?.position ?? state.playback.currentTime, active?.duration ?? state.playback.duration, active?.gain ?? 1),
        secondary: deck(secondaryTrack, other?.position ?? 0, other?.duration ?? secondaryTrack?.duration ?? 0, other?.gain ?? 0),
        transition: !playing || mix.phase === 'idle'
          ? null
          : {
              technique: mix.technique ?? 'safe_fade',
              phase: mix.phase,
              progress: mix.progress,
              dominant: mix.dominant,
            },
      };
      sendProgramEvent(payload);
      lastEmit = now;
      wasPlaying = playing;
      if (mix.phase === 'idle') previousTrack = null;
    }, 250);
  });

  createEffect(() => {
    if (hostSession()) return;
    publishing = false;
    wasPlaying = false;
    pausedSince = null;
    lastEmit = 0;
    captureMissingSince = null;
    reportedMissingCapture = false;
    resetCapture();
    releaseBroadcastStream();
  });

  onCleanup(() => {
    window.clearInterval(timer);
    setBroadcastLostReporter(null);
    resetCapture();
    releaseBroadcastStream();
    // Closing the page is allowed to use the short resume window; do not
    // explicitly end the public room here.
  });

  return null;
}
