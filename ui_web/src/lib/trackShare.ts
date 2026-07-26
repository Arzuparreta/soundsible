import { playbackYoutubeId } from './media';
import { isPodcastTrack } from './track';

export const SOUNDSIBLE_SHARE_BRIDGE =
  import.meta.env.VITE_SOUNDSIBLE_SHARE_BRIDGE ||
  'https://arzuparreta.github.io/soundsible.github.io/open/';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CAPSULE = /^[A-Za-z0-9_-]+$/;
const MAX_CAPSULE_BYTES = 2048;
const MAX_TEXT_LENGTH = 256;

export interface SharedTrack {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
  youtube_id?: string | null;
  source?: 'preview';
  media_kind?: string | null;
  podcast_episode_guid?: string | null;
}

export interface TrackShareCapsuleV1 {
  v: 1;
  kind: 'music';
  yt: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
}

function cleanText(value: unknown, required = false): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim();
  if ((required && !clean) || clean.length > MAX_TEXT_LENGTH) return undefined;
  return clean || undefined;
}

function isCapsule(value: unknown): value is TrackShareCapsuleV1 {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  if (c.v !== 1 || c.kind !== 'music' || typeof c.yt !== 'string' || !VIDEO_ID.test(c.yt)) return false;
  if (!cleanText(c.title, true) || typeof c.artist !== 'string' || c.artist.trim().length > MAX_TEXT_LENGTH) return false;
  if (c.album !== undefined && !cleanText(c.album)) return false;
  if (
    c.duration !== undefined &&
    (typeof c.duration !== 'number' || !Number.isFinite(c.duration) || c.duration < 0 || c.duration > 86400)
  ) {
    return false;
  }
  return Object.keys(c).every((key) =>
    ['v', 'kind', 'yt', 'title', 'artist', 'album', 'duration'].includes(key),
  );
}

export function capsuleForTrack(track: SharedTrack): TrackShareCapsuleV1 | null {
  if (isPodcastTrack(track)) return null;
  const yt = playbackYoutubeId(track);
  const title = cleanText(track.title, true);
  const artist = cleanText(track.artist) || '';
  if (!yt || !VIDEO_ID.test(yt) || !title) return null;

  const capsule: TrackShareCapsuleV1 = { v: 1, kind: 'music', yt, title, artist };
  const album = cleanText(track.album);
  if (album) capsule.album = album;
  if (
    typeof track.duration === 'number' &&
    Number.isFinite(track.duration) &&
    track.duration >= 0 &&
    track.duration <= 86400
  ) {
    capsule.duration = track.duration;
  }
  return capsule;
}

export function encodeTrackCapsule(capsule: TrackShareCapsuleV1): string {
  if (!isCapsule(capsule)) throw new Error('Invalid Soundsible track capsule');
  const bytes = new TextEncoder().encode(JSON.stringify(capsule));
  if (bytes.byteLength > MAX_CAPSULE_BYTES) throw new Error('Soundsible track capsule is too large');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeTrackCapsule(encoded: string): TrackShareCapsuleV1 | null {
  if (!encoded || encoded.length > MAX_CAPSULE_BYTES * 2 || !CAPSULE.test(encoded)) return null;
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    if (bytes.byteLength > MAX_CAPSULE_BYTES) return null;
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return isCapsule(value) ? value : null;
  } catch {
    return null;
  }
}

export function shareUrlForTrack(track: SharedTrack): string | null {
  const capsule = capsuleForTrack(track);
  if (!capsule) return null;
  const base = SOUNDSIBLE_SHARE_BRIDGE.endsWith('/')
    ? SOUNDSIBLE_SHARE_BRIDGE
    : `${SOUNDSIBLE_SHARE_BRIDGE}/`;
  return `${base}#t=${encodeTrackCapsule(capsule)}`;
}

export function sharedCapsuleFromSearch(search: string): { encoded: string; capsule: TrackShareCapsuleV1 } | null {
  const encoded = new URLSearchParams(search).get('shared') || '';
  const capsule = decodeTrackCapsule(encoded);
  return capsule ? { encoded, capsule } : null;
}

export function sharedCapsuleFromHash(hash: string): { encoded: string; capsule: TrackShareCapsuleV1 } | null {
  const queryAt = hash.indexOf('?');
  return queryAt < 0 ? null : sharedCapsuleFromSearch(hash.slice(queryAt));
}

export function soundsiblePlayerBase(): string | null {
  if (typeof window === 'undefined' || /\/player\/desktop\/(?:$|[?#])/.test(window.location.href)) return null;
  const marker = '/player/';
  const index = window.location.pathname.indexOf(marker);
  if (index < 0) return null;
  return `${window.location.origin}${window.location.pathname.slice(0, index + marker.length)}`;
}

export function associationUrl(): string | null {
  const player = soundsiblePlayerBase();
  if (!player) return null;
  const bridge = SOUNDSIBLE_SHARE_BRIDGE.endsWith('/')
    ? SOUNDSIBLE_SHARE_BRIDGE
    : `${SOUNDSIBLE_SHARE_BRIDGE}/`;
  const returnTo = `${player}#/settings`;
  return `${bridge}#register=${encodeURIComponent(player)}&return=${encodeURIComponent(returnTo)}`;
}
