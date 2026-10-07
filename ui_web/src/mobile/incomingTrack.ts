import { decodeTrackCapsule, SOUNDSIBLE_SHARE_BRIDGE, type TrackShareCapsuleV1 } from '../lib/trackShare';

/** Incoming links carry public song identity only, never connection settings or playback commands. */
export function incomingTrack(url: string): TrackShareCapsuleV1 | null {
  if (!url || url.length > 8192) return null;
  try {
    const value = new URL(url);
    if (value.username || value.password) return null;
    let encoded: string | null = null;
    if (value.protocol === 'soundsible:' && value.hostname === 'open' && !value.pathname && !value.hash &&
      [...value.searchParams.keys()].length === 1 && value.searchParams.has('shared')) {
      encoded = value.searchParams.get('shared');
    } else {
      const expected = new URL(SOUNDSIBLE_SHARE_BRIDGE);
      const path = expected.pathname.endsWith('/') ? expected.pathname : expected.pathname + '/';
      if (value.protocol !== 'https:' || value.origin !== expected.origin || value.pathname !== path || value.search || !value.hash.startsWith('#t=')) return null;
      encoded = value.hash.slice(3);
    }
    return encoded ? decodeTrackCapsule(encoded) : null;
  } catch { return null; }
}
