import { createEffect, onCleanup, onMount } from 'solid-js';
import { state } from '../stores';
import {
  broadcastStream,
  programMixSnapshot,
  releaseBroadcastStream,
} from '../lib/audio';
import {
  hostSession,
  publisherConnected,
  resumeCommunityIfActive,
  sendProgramEvent,
  startHostPublisher,
  uploadHostArtwork,
  type LiveDeck,
  type LiveProgram,
} from '../lib/community';
import type { Track } from '../types/music';
import { coverUrl } from '../lib/media';

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

  onMount(() => {
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

      if (state.playback.isPlaying && !publishing) {
        publishing = true;
        const stream = broadcastStream();
        if (stream) {
          void startHostPublisher(stream).catch(() => {
            publishing = false;
          });
        } else {
          publishing = false;
        }
      }
      if (!publisherConnected()) return;
      const playing = state.playback.isPlaying;
      if (!playing && !wasPlaying) return;

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
        emitted_at: Date.now(),
        program_time: mix.contextTime,
        transport: playing ? 'playing' : 'paused',
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
      wasPlaying = playing;
      if (mix.phase === 'idle') previousTrack = null;
    }, 250);
  });

  createEffect(() => {
    if (hostSession()) return;
    publishing = false;
    wasPlaying = false;
    releaseBroadcastStream();
  });

  onCleanup(() => {
    window.clearInterval(timer);
    releaseBroadcastStream();
    // Closing the page is allowed to use the 90-second resume window; do not
    // explicitly end the public room here.
  });

  return null;
}
