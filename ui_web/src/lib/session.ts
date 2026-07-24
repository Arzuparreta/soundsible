/**
 * Who the player is talking as.
 *
 * The engine keeps the session in an HttpOnly cookie, so the client never holds
 * a token — it just asks `/api/auth/state` who it is. While the instance has a
 * single passwordless account, `requiresLogin` stays false and nothing changes
 * from the single-user days.
 */
import { createSignal } from 'solid-js';
import { request, setUnauthorizedHandler } from './api';

export type Role = 'admin' | 'member';

export interface User {
  id: string;
  username: string;
  display_name: string;
  avatar_color?: string | null;
  role: Role;
  has_password: boolean;
  created_at?: string | null;
  disabled?: boolean;
}

interface AuthState {
  requires_login: boolean;
  user: User | null;
}

const [user, setUser] = createSignal<User | null>(null);
const [requiresLogin, setRequiresLogin] = createSignal(false);
const [ready, setReady] = createSignal(false);

export { user, requiresLogin, ready };

/** True when the signed-in account may change instance settings and accounts. */
export function isAdmin(): boolean {
  return user()?.role === 'admin';
}

/** Preferences are per person on a shared device — namespace them by account. */
export function userKey(key: string): string {
  const id = user()?.id;
  return id ? `u:${id}:${key}` : key;
}

function applyState(state: AuthState): AuthState {
  setRequiresLogin(Boolean(state.requires_login));
  setUser(state.user ?? null);
  return state;
}

/** Ask the engine who we are. Safe to call repeatedly. */
export async function refreshSession(): Promise<AuthState> {
  try {
    const state = await request<AuthState>('/api/auth/state');
    return applyState(state);
  } catch {
    // The engine is unreachable; leave the app in whatever state it had rather
    // than bouncing a working session to the login screen.
    return { requires_login: requiresLogin(), user: user() };
  } finally {
    setReady(true);
  }
}

export async function login(username: string, password: string): Promise<User> {
  const res = await request<{ user: User }>('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  setUser(res.user);
  setRequiresLogin(true);
  return res.user;
}

export async function logout(): Promise<void> {
  try {
    await request<void>('/api/auth/logout', { method: 'POST' });
  } finally {
    setUser(null);
    // A full reload is the honest way to drop every cached store, signal, and
    // in-flight request belonging to the account that just left.
    if (typeof window !== 'undefined') window.location.reload();
  }
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await request<void>('/api/auth/password', {
    method: 'POST',
    body: { current_password: currentPassword, new_password: newPassword },
  });
  await refreshSession();
}

/** Wire the API layer so any 401 drops the app back to the login screen. */
export function installSessionGuard(): void {
  setUnauthorizedHandler(() => {
    setUser(null);
    setRequiresLogin(true);
  });
}

/* ── Account management (admin only) ── */

export interface CreateUserInput {
  username: string;
  password?: string;
  display_name?: string;
  role?: Role;
}

export interface Invite {
  id: string;
  role: Role;
  created_at?: string | null;
  expires_at?: string | null;
  used: boolean;
  revoked: boolean;
}

export const invites = {
  list: () => request<{ invites: Invite[] }>('/api/invites'),
  // Anonymous by design: the person who redeems it chooses their own name.
  create: () =>
    request<{ invite: Invite; token: string; url: string }>('/api/invites', {
      method: 'POST',
      body: {},
    }),
  revoke: (id: string) => request<{ status: string }>(`/api/invites/${id}`, { method: 'DELETE' }),
  /** Public: does this link still work? Carries no identity. */
  preview: (token: string) =>
    request<{ valid: boolean }>(`/api/invites/${encodeURIComponent(token)}/preview`),
  /** Public: create the account the link stands for and sign in. */
  accept: (token: string, username: string, password: string) =>
    request<{ user: User }>(`/api/invites/${encodeURIComponent(token)}/accept`, {
      method: 'POST',
      body: { username, password },
    }),
};

export const users = {
  list: () => request<{ users: User[]; requires_login: boolean }>('/api/users'),
  create: (input: CreateUserInput) =>
    request<{ user: User; requires_login: boolean }>('/api/users', { method: 'POST', body: input }),
  update: (id: string, patch: Partial<Pick<User, 'display_name' | 'role' | 'username'>> & { disabled?: boolean }) =>
    request<{ user: User }>(`/api/users/${id}`, { method: 'PATCH', body: patch }),
  setPassword: (id: string, password: string) =>
    request<{ user: User }>(`/api/users/${id}/password`, { method: 'POST', body: { password } }),
  revokeSessions: (id: string) =>
    request<{ revoked: number }>(`/api/users/${id}/sessions`, { method: 'DELETE' }),
  remove: (id: string) => request<{ status: string }>(`/api/users/${id}`, { method: 'DELETE' }),
};
