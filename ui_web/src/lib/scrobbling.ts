import { createSignal, onCleanup } from 'solid-js';
import { confirmDialog } from './confirm';
import { ApiError, request } from './http';
import { t } from './i18n';
import { promptDialog } from './prompt';

export type ScrobbleServiceId = 'listenbrainz' | 'lastfm' | 'maloja';

export interface ScrobbleServiceStatus {
  service: ScrobbleServiceId;
  connected: boolean;
  /** Present once connected. */
  enabled?: boolean;
  username?: string;
  /** Empty for the service's own address. */
  server?: string;
  state?: 'ok' | 'retrying' | 'reconnect';
  /** Plays recorded and not yet accepted by the service. */
  pending?: number;
  last_sent_at?: number | null;
  error?: string;
  /** Last.fm only: this server has an API account to connect through. */
  available?: boolean;
  /** Last.fm only: a link was issued and has not been used yet. */
  authorizing?: boolean;
}

export interface ScrobbleStatus {
  services: ScrobbleServiceStatus[];
  /** Whether this account may name a server of its own (admins only). */
  custom_servers: boolean;
  /** Present for admins only. */
  lastfm_app?: { configured: boolean; from_environment: boolean };
}

/** The engine checks a token with the service before it answers. */
const CONNECT_TIMEOUT_MS = 25000;

const ERROR_KEYS = {
  token_required: 'scrobbling.error.tokenRequired',
  token_rejected: 'scrobbling.error.tokenRejected',
  unreachable: 'scrobbling.error.unreachable',
  not_listenbrainz: 'scrobbling.error.notListenBrainz',
  server_invalid: 'scrobbling.error.serverInvalid',
  custom_server_forbidden: 'scrobbling.error.customServerForbidden',
  api_key_rejected: 'scrobbling.error.apiKeyRejected',
  lastfm_unavailable: 'scrobbling.error.lastfmUnavailable',
  lastfm_not_started: 'scrobbling.error.lastfmExpired',
  lastfm_expired: 'scrobbling.error.lastfmExpired',
  lastfm_not_authorized: 'scrobbling.error.lastfmNotAuthorized',
} as const;

function errorCode(error: unknown): string {
  const payload = error instanceof ApiError ? error.payload : undefined;
  const code = payload && typeof payload === 'object' ? (payload as { error?: unknown }).error : undefined;
  return typeof code === 'string' ? code : '';
}

function errorMessage(error: unknown): string {
  const key = ERROR_KEYS[errorCode(error) as keyof typeof ERROR_KEYS];
  return t(key ?? 'scrobbling.error.generic');
}

/** A brand name, the same in every language; a key because the settings search lists it. */
export function serviceName(service: ScrobbleServiceId): string {
  return t(`scrobbling.${service}Label`);
}

/** Who an operation was started for. An answer is used only while that is still who is looking. */
export interface ScrobblingOwner {
  current: () => boolean;
  signal?: AbortSignal;
}

const ANYONE: ScrobblingOwner = { current: () => true };
const NOBODY: ScrobblingOwner = { current: () => false };

/**
 * Connecting, pausing and disconnecting scrobbling services for the signed-in
 * account. One controller for the web player and the Android app: it talks to
 * the engine through `request`, which each of them supplies a transport for.
 *
 * `owner` is how the Android app says which account and server an operation
 * belongs to. It is read once, when the operation starts: an answer that
 * arrives after the account changed belongs to somebody else and is dropped.
 * `onError` receives a translated sentence; without it the sentence is held in
 * `error()` for the caller to draw.
 */
export function createScrobbling(opts: {
  owner?: () => ScrobblingOwner | undefined;
  onError?: (message: string) => void;
} = {}) {
  const [status, setStatus] = createSignal<ScrobbleStatus | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  /** The Last.fm page that grants access, between asking for it and finishing. */
  const [lastfmUrl, setLastfmUrl] = createSignal('');
  const begin = (): ScrobblingOwner => (opts.owner ? opts.owner() ?? NOBODY : ANYONE);

  const call = <T,>(owner: ScrobblingOwner, path: string, method = 'GET', body?: unknown, timeoutMs?: number) =>
    request<T>(path, { method, body, timeoutMs, signal: owner.signal });

  function fail(owner: ScrobblingOwner, reason: unknown): void {
    if (!owner.current()) return;
    const message = errorMessage(reason);
    if (opts.onError) opts.onError(message);
    else setError(message);
  }

  /** One change at a time; its answer is the new status. */
  async function change(owner: ScrobblingOwner, action: () => Promise<ScrobbleStatus>): Promise<boolean> {
    if (busy() || !owner.current()) return false;
    setBusy(true);
    setError('');
    try {
      const next = await action();
      if (!owner.current()) return false;
      setStatus(next);
      return true;
    } catch (reason) {
      fail(owner, reason);
      return false;
    } finally {
      if (owner.current()) setBusy(false);
    }
  }

  const entry = (service: ScrobbleServiceId) => status()?.services.find((item) => item.service === service);

  async function load(): Promise<void> {
    const owner = begin();
    const next = await call<ScrobbleStatus>(owner, '/api/scrobble');
    if (owner.current()) setStatus(next);
  }

  /** `custom` asks for the server's address first; only admins are offered it. */
  async function connectListenBrainz(custom = false): Promise<void> {
    const owner = begin();
    let server: string | null = '';
    if (custom) {
      server = await promptDialog({
        title: t('scrobbling.listenbrainzServerTitle'),
        message: t('scrobbling.listenbrainzServerMessage'),
        inputLabel: t('scrobbling.serverAddress'),
        placeholder: 'https://',
        confirmLabel: t('common.continue'),
      }, owner.current);
      if (!server) return;
    }
    const token = await promptDialog({
      title: t('scrobbling.connectService', { service: serviceName('listenbrainz') }),
      message: t('scrobbling.listenbrainzTokenMessage'),
      inputLabel: t('scrobbling.userToken'),
      confirmLabel: t('scrobbling.connect'),
    }, owner.current);
    if (!token) return;
    await change(owner, () => call(owner, '/api/scrobble/listenbrainz', 'PUT', { token, server }, CONNECT_TIMEOUT_MS));
  }

  async function connectMaloja(): Promise<void> {
    const owner = begin();
    const server = await promptDialog({
      title: t('scrobbling.connectService', { service: serviceName('maloja') }),
      message: t('scrobbling.malojaServerMessage'),
      inputLabel: t('scrobbling.serverAddress'),
      placeholder: 'http://',
      confirmLabel: t('common.continue'),
    }, owner.current);
    if (!server) return;
    const token = await promptDialog({
      title: t('scrobbling.connectService', { service: serviceName('maloja') }),
      message: t('scrobbling.malojaKeyMessage'),
      inputLabel: t('scrobbling.apiKey'),
      confirmLabel: t('scrobbling.connect'),
    }, owner.current);
    if (!token) return;
    await change(owner, () => call(owner, '/api/scrobble/maloja', 'PUT', { server, token }, CONNECT_TIMEOUT_MS));
  }

  /** Ask Last.fm for the page where the listener allows access. */
  async function startLastfm(): Promise<void> {
    const owner = begin();
    await change(owner, async () => {
      const { url } = await call<{ url: string }>(owner, '/api/scrobble/lastfm/authorize', 'POST', undefined, CONNECT_TIMEOUT_MS);
      if (owner.current()) setLastfmUrl(url);
      return call<ScrobbleStatus>(owner, '/api/scrobble');
    });
  }

  /** `quiet` is the attempt made on returning to the page: not allowed yet is no error. */
  async function finishLastfm(quiet = false): Promise<void> {
    const owner = begin();
    if (busy() || !owner.current()) return;
    setBusy(true);
    setError('');
    try {
      const next = await call<ScrobbleStatus>(owner, '/api/scrobble/lastfm/complete', 'POST', undefined, CONNECT_TIMEOUT_MS);
      if (!owner.current()) return;
      setStatus(next);
      setLastfmUrl('');
    } catch (reason) {
      const code = errorCode(reason);
      if (!quiet || code !== 'lastfm_not_authorized') fail(owner, reason);
      if (code === 'lastfm_expired' || code === 'lastfm_not_started') {
        // The link is spent or was never issued: offer a new one, from what
        // the engine now says rather than from what this page remembers.
        if (owner.current()) setLastfmUrl('');
        const next = await call<ScrobbleStatus>(owner, '/api/scrobble').catch(() => null);
        if (next && owner.current()) setStatus(next);
      }
    } finally {
      if (owner.current()) setBusy(false);
    }
  }

  // Allowing access happens in another tab. Coming back to this one is the
  // listener saying they are done there, so the button is one tap they are spared.
  const onReturn = () => {
    if (document.visibilityState === 'visible' && lastfmUrl()) void finishLastfm(true);
  };
  document.addEventListener('visibilitychange', onReturn);
  onCleanup(() => document.removeEventListener('visibilitychange', onReturn));

  async function setLastfmApp(): Promise<void> {
    const owner = begin();
    const apiKey = await promptDialog({
      title: t('scrobbling.lastfmAppTitle'),
      message: t('scrobbling.lastfmAppMessage'),
      inputLabel: t('scrobbling.apiKey'),
      confirmLabel: t('common.continue'),
    }, owner.current);
    if (!apiKey) return;
    const apiSecret = await promptDialog({
      title: t('scrobbling.lastfmAppTitle'),
      message: t('scrobbling.lastfmSecretMessage'),
      inputLabel: t('scrobbling.sharedSecret'),
      confirmLabel: t('common.save'),
    }, owner.current);
    if (!apiSecret) return;
    const body = { api_key: apiKey, api_secret: apiSecret };
    await change(owner, () => call(owner, '/api/scrobble/lastfm/app', 'PUT', body, CONNECT_TIMEOUT_MS));
  }

  async function removeLastfmApp(): Promise<void> {
    const owner = begin();
    const confirmed = await confirmDialog({
      title: t('scrobbling.removeLastfmAppTitle'),
      message: t('scrobbling.removeLastfmAppMessage'),
      confirmLabel: t('scrobbling.removeLastfmApp'),
      danger: true,
    }, owner.current);
    if (!confirmed) return;
    await change(owner, () => call(owner, '/api/scrobble/lastfm/app', 'DELETE'));
  }

  async function toggle(service: ScrobbleServiceId): Promise<void> {
    const owner = begin();
    const item = entry(service);
    if (!item?.connected) return;
    await change(owner, () => call(owner, `/api/scrobble/${service}`, 'PATCH', { enabled: !item.enabled }));
  }

  async function retry(service: ScrobbleServiceId): Promise<void> {
    const owner = begin();
    await change(owner, () => call(owner, `/api/scrobble/${service}/retry`, 'POST'));
  }

  async function disconnect(service: ScrobbleServiceId): Promise<void> {
    const owner = begin();
    const pending = entry(service)?.pending ?? 0;
    const confirmed = await confirmDialog({
      title: t('scrobbling.disconnectTitle', { service: serviceName(service) }),
      message: pending > 0 ? t('scrobbling.disconnectPending', { count: pending }) : t('scrobbling.disconnectMessage'),
      confirmLabel: t('scrobbling.disconnect'),
      danger: true,
    }, owner.current);
    if (!confirmed) return;
    await change(owner, () => call(owner, `/api/scrobble/${service}`, 'DELETE'));
  }

  function connect(service: ScrobbleServiceId): Promise<void> {
    if (service === 'lastfm') return startLastfm();
    return service === 'maloja' ? connectMaloja() : connectListenBrainz();
  }

  /** Forget everything shown: the account or the server behind it changed. */
  function reset(): void {
    setStatus(null);
    setBusy(false);
    setError('');
    setLastfmUrl('');
  }

  return {
    status, busy, error, lastfmUrl, load, reset, connect, connectListenBrainz, finishLastfm,
    setLastfmApp, removeLastfmApp, toggle, retry, disconnect,
  };
}

export type ScrobblingController = ReturnType<typeof createScrobbling>;
