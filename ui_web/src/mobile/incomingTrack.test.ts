import { expect, it } from 'vitest';
import { incomingTrack } from './incomingTrack';
import { encodeTrackCapsule, shareUrlForTrack } from '../lib/trackShare';
const capsule = { v: 1 as const, kind: 'music' as const, yt: 'dQw4w9WgXcQ', title: 'Canción 日本', artist: 'Björk' };
it('accepts the same public fragment link as web and the explicit native open scheme', () => {
  const encoded = encodeTrackCapsule(capsule);
  expect(incomingTrack(shareUrlForTrack({ id: capsule.yt, source: 'preview', title: capsule.title, artist: capsule.artist })!)).toEqual(capsule);
  expect(incomingTrack('soundsible://open?shared=' + encoded)).toEqual(capsule);
});
it('rejects connections, private hosts, credentials, queries and ambiguous payloads', () => {
  const encoded = encodeTrackCapsule(capsule);
  for (const url of ['soundsible://connect?server=https://private.invalid', 'soundsible://open?shared=' + encoded + '&shared=' + encoded,
    'soundsible://open?shared=' + encoded + '&server=https://private.invalid',
    'https://private.invalid/open/#t=' + encoded,
    'https://secret@arzuparreta.github.io/soundsible.github.io/open/#t=' + encoded,
    'https://arzuparreta.github.io/soundsible.github.io/open/?token=secret#t=' + encoded]) expect(incomingTrack(url)).toBeNull();
});
it('refuses unknown fields, invalid identities and oversized input instead of accepting external sources', () => {
  const encoded = btoa(JSON.stringify({ ...capsule, title: 'Song', artist: 'Artist', source: 'https://private.invalid/api/static/stream' })).replace(/=/g, '');
  expect(incomingTrack('soundsible://open?shared=' + encoded)).toBeNull();
  expect(incomingTrack('soundsible://open?shared=invalid')).toBeNull();
  expect(incomingTrack('x'.repeat(8193))).toBeNull();
});
