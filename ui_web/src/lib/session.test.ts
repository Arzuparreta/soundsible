import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.fn();
const setUnauthorizedHandlerMock = vi.fn();

vi.mock('./api', () => ({
  request: (...args: unknown[]) => requestMock(...args),
  setUnauthorizedHandler: (h: unknown) => setUnauthorizedHandlerMock(h),
}));

import {
  installSessionGuard,
  isAdmin,
  login,
  refreshSession,
  requiresLogin,
  user,
  userKey,
} from './session';

const ADMIN = {
  id: 'u-admin',
  username: 'owner',
  display_name: 'Owner',
  role: 'admin' as const,
  has_password: true,
};

const MEMBER = { ...ADMIN, id: 'u-ana', username: 'ana', display_name: 'Ana', role: 'member' as const };

describe('session', () => {
  beforeEach(() => {
    requestMock.mockReset();
    setUnauthorizedHandlerMock.mockReset();
  });

  it('reflects an open single-user instance', async () => {
    requestMock.mockResolvedValue({ requires_login: false, user: null });

    await refreshSession();

    expect(requiresLogin()).toBe(false);
    expect(user()).toBeNull();
  });

  it('stores the signed-in account after login', async () => {
    requestMock.mockResolvedValue({ user: MEMBER });

    const result = await login('ana', 'secret123');

    expect(result.username).toBe('ana');
    expect(user()?.id).toBe('u-ana');
    expect(requiresLogin()).toBe(true);
    expect(isAdmin()).toBe(false);
  });

  it('reports admin only for the admin role', async () => {
    requestMock.mockResolvedValue({ requires_login: true, user: ADMIN });

    await refreshSession();

    expect(isAdmin()).toBe(true);
  });

  it('namespaces preference keys by account', async () => {
    requestMock.mockResolvedValue({ requires_login: true, user: MEMBER });
    await refreshSession();

    expect(userKey('recents')).toBe('u:u-ana:recents');
  });

  it('keeps the session when the engine is unreachable', async () => {
    requestMock.mockResolvedValue({ requires_login: true, user: MEMBER });
    await refreshSession();

    requestMock.mockRejectedValue(new Error('offline'));
    const state = await refreshSession();

    expect(state.user?.id).toBe('u-ana');
    expect(user()?.id).toBe('u-ana');
  });

  it('drops to the login screen when a request comes back 401', async () => {
    requestMock.mockResolvedValue({ requires_login: true, user: MEMBER });
    await refreshSession();

    installSessionGuard();
    const handler = setUnauthorizedHandlerMock.mock.calls[0][0] as () => void;
    handler();

    expect(user()).toBeNull();
    expect(requiresLogin()).toBe(true);
  });
});
