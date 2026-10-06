import { expect, it } from 'vitest';
import { liveArtworkUrl } from './livePresentation';
it('accepts only the public thumbnail of this room at its configured HTTPS origin', () => {
  const origin = 'https://community.example', id = 'isolated-room-123', valid = `${origin}/v1/artwork/${id}/one.jpg`;
  expect(liveArtworkUrl(valid, origin, id)).toBe(valid);
  for (const value of [valid.replace('community.example', 'foreign.example'), valid.replace(id, 'other-room-123'),
    valid.replace('https:', 'http:'), `${valid}?token=private`, `${valid}#fragment`, valid.replace('https://', 'https://user:password@'),
    valid.replace('one.jpg', '../one.jpg'), 'invalid']) expect(liveArtworkUrl(value, origin, id)).toBeUndefined();
});
