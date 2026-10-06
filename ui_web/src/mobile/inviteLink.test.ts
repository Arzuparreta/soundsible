import { expect, it } from 'vitest';
import { nativeInviteLink } from './inviteLink';
it('extracts only the origin and token from an explicit engine invitation', () => {
  for (const origin of ['https://music.example', 'http://10.0.2.2:5097']) {
    expect(nativeInviteLink(`${origin}/player/#/invite/isolated_invite_token`)).toEqual({ origin, token: 'isolated_invite_token' });
  }
  for (const url of ['https://user:password@music.example/player/#/invite/isolated_invite_token',
    'https://music.example/player/?redirect=other#/invite/isolated_invite_token',
    'https://music.example/other/#/invite/isolated_invite_token', 'https://music.example/player/#/invite/../other',
    'https://music.example/player/#/invite/short', 'soundsible://invite/isolated_invite_token']) expect(nativeInviteLink(url)).toBeNull();
});
