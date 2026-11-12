import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../lib/i18n';
import type { ScrobbleServiceStatus, ScrobbleStatus } from '../lib/scrobbling';
import { ScrobblingPanel } from './ScrobblingPanel';

const { requestMock, promptMock, confirmMock, toastMock, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(readonly status: number, message: string, readonly code?: string, readonly payload?: unknown) {
      super(message);
    }
  }
  return { requestMock: vi.fn(), promptMock: vi.fn(), confirmMock: vi.fn(), toastMock: { error: vi.fn() }, ApiError };
});

vi.mock('../lib/http', () => ({ request: requestMock, ApiError }));
vi.mock('../lib/prompt', () => ({ promptDialog: promptMock }));
vi.mock('../lib/confirm', () => ({ confirmDialog: confirmMock }));
vi.mock('../lib/toast', () => ({ toast: toastMock }));

function status(overrides: Partial<Record<string, Partial<ScrobbleServiceStatus>>> = {}, extra: Partial<ScrobbleStatus> = {}): ScrobbleStatus {
  const service = (name: ScrobbleServiceStatus['service'], base: Partial<ScrobbleServiceStatus> = {}) =>
    ({ service: name, connected: false, ...base, ...overrides[name] }) as ScrobbleServiceStatus;
  return {
    services: [service('listenbrainz'), service('lastfm', { available: false, authorizing: false }), service('maloja')],
    custom_servers: false,
    ...extra,
  };
}

const CONNECTED: Partial<ScrobbleServiceStatus> = {
  connected: true, enabled: true, username: 'ana', server: '', state: 'ok', pending: 0, last_sent_at: null, error: '',
};

/** Answers each engine call from a table of `METHOD path` → response (or a thrown ApiError). */
function engine(routes: Record<string, unknown>) {
  requestMock.mockImplementation(async (path: string, opts: { method?: string } = {}) => {
    const key = `${opts.method ?? 'GET'} ${path}`;
    if (!(key in routes)) throw new Error(`unexpected ${key}`);
    const answer = routes[key];
    if (answer instanceof Error) throw answer;
    return answer;
  });
}

const refusal = (code: string, httpStatus = 400) => new ApiError(httpStatus, code, undefined, { error: code });
const called = (key: string) => requestMock.mock.calls.filter(([path, opts]) => `${opts?.method ?? 'GET'} ${path}` === key);

describe('Scrobbling settings', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    confirmMock.mockResolvedValue(true);
    await setLocale('en');
  });

  it('offers each service a member can connect, and says what is sent', async () => {
    engine({ 'GET /api/scrobble': status() });
    render(() => <ScrobblingPanel />);
    expect(await screen.findByRole('button', { name: /Connect ListenBrainz/ })).toBeInTheDocument();
    // Last.fm needs an API key only an admin can add; Maloja needs a server only an admin can name.
    expect(screen.getByText('Last.fm is not set up on this server')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add a Last.fm API key/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect Maloja/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /another ListenBrainz server/ })).not.toBeInTheDocument();
    expect(screen.getByText('Half its length, or 4 minutes')).toBeInTheDocument();
    expect(screen.getByText('Not sent')).toBeInTheDocument();
  });

  it('connects ListenBrainz with a pasted token', async () => {
    engine({
      'GET /api/scrobble': status(),
      'PUT /api/scrobble/listenbrainz': status({ listenbrainz: CONNECTED }),
    });
    promptMock.mockResolvedValueOnce('lb-token');
    render(() => <ScrobblingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Connect ListenBrainz/ }));

    expect(await screen.findByRole('switch', { name: 'Send what I play' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Connected as ana')).toBeInTheDocument();
    expect(screen.getByText('Up to date')).toBeInTheDocument();
    expect(screen.getByText('Never')).toBeInTheDocument();
    const [[, options]] = called('PUT /api/scrobble/listenbrainz');
    expect(options.body).toEqual({ token: 'lb-token', server: '' });
    // The engine checks the token with ListenBrainz before answering.
    expect(options.timeoutMs).toBeGreaterThan(8000);
  });

  it('does nothing when the token prompt is cancelled', async () => {
    engine({ 'GET /api/scrobble': status() });
    promptMock.mockResolvedValueOnce(null);
    render(() => <ScrobblingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Connect ListenBrainz/ }));
    await waitFor(() => expect(promptMock).toHaveBeenCalled());
    expect(called('PUT /api/scrobble/listenbrainz')).toHaveLength(0);
  });

  it('says why a token was refused and stays disconnected', async () => {
    engine({ 'GET /api/scrobble': status(), 'PUT /api/scrobble/listenbrainz': refusal('token_rejected') });
    promptMock.mockResolvedValueOnce('bad');
    render(() => <ScrobblingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Connect ListenBrainz/ }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('The service did not accept that token or key.'));
    expect(screen.getByRole('button', { name: /Connect ListenBrainz/ })).toBeEnabled();
  });

  it('lets an admin name a server: Maloja, or a ListenBrainz of their own', async () => {
    engine({
      'GET /api/scrobble': status({}, { custom_servers: true, lastfm_app: { configured: false, from_environment: false } }),
      'PUT /api/scrobble/maloja': status(
        { maloja: { ...CONNECTED, username: 'home', server: 'http://maloja.lan:42010' } },
        { custom_servers: true },
      ),
    });
    promptMock.mockResolvedValueOnce('http://maloja.lan:42010').mockResolvedValueOnce('maloja-key');
    render(() => <ScrobblingPanel />);
    expect(await screen.findByRole('button', { name: /another ListenBrainz server/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add a Last.fm API key/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Connect Maloja/ }));

    expect(await screen.findByText('Connected as home on http://maloja.lan:42010')).toBeInTheDocument();
    expect(called('PUT /api/scrobble/maloja')[0][1].body).toEqual({ server: 'http://maloja.lan:42010', token: 'maloja-key' });
  });

  it('connects Last.fm through a link, and finishes on return to the page', async () => {
    let authorizing = false;
    requestMock.mockImplementation(async (path: string, opts: { method?: string } = {}) => {
      const key = `${opts.method ?? 'GET'} ${path}`;
      if (key === 'GET /api/scrobble') return status({ lastfm: { available: true, authorizing } });
      if (key === 'POST /api/scrobble/lastfm/authorize') {
        authorizing = true;
        return { url: 'https://www.last.fm/api/auth/?api_key=k&token=t' };
      }
      if (key === 'POST /api/scrobble/lastfm/complete') {
        if (called(key).length === 1) throw refusal('lastfm_not_authorized', 409);
        return status({ lastfm: { ...CONNECTED, username: 'ana_fm', available: true, authorizing: false } });
      }
      throw new Error(`unexpected ${key}`);
    });
    render(() => <ScrobblingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Connect Last\.fm/ }));

    const link = await screen.findByRole('link', { name: /Open Last\.fm/ });
    expect(link).toHaveAttribute('href', 'https://www.last.fm/api/auth/?api_key=k&token=t');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');

    // Back on the page before pressing "allow" on Last.fm: tried quietly, no error shown.
    await waitFor(() => expect(screen.getByRole('button', { name: /Finish connecting/ })).toBeEnabled());
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(called('POST /api/scrobble/lastfm/complete')).toHaveLength(1));
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: /Open Last\.fm/ })).toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('button', { name: /Finish connecting/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Finish connecting/ }));
    expect(await screen.findByText('Connected as ana_fm')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open Last\.fm/ })).not.toBeInTheDocument();
  });

  it('can still finish after a reload, and offers a fresh link when the old one is spent', async () => {
    let authorizing = true;
    let allowed = false;
    requestMock.mockImplementation(async (path: string, opts: { method?: string } = {}) => {
      const key = `${opts.method ?? 'GET'} ${path}`;
      if (key === 'GET /api/scrobble') return status({ lastfm: { available: true, authorizing } });
      if (key === 'POST /api/scrobble/lastfm/complete') {
        if (allowed) return status({ lastfm: { ...CONNECTED, username: 'ana_fm', available: true, authorizing: false } });
        authorizing = false;
        throw refusal('lastfm_expired', 409);
      }
      throw new Error(`unexpected ${key}`);
    });
    const view = render(() => <ScrobblingPanel />);
    // The page was reloaded after the link was issued: it cannot show the link
    // again, but what was allowed through it can still be collected.
    expect(await screen.findByRole('button', { name: /Connect Last\.fm/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open Last\.fm/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Finish connecting/ }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith('That Last.fm link is no longer valid. Start connecting again.'),
    );
    // The engine no longer holds a link, so there is nothing left to finish.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Finish connecting/ })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Connect Last\.fm/ })).toBeEnabled();
    view.unmount();

    authorizing = true;
    allowed = true;
    render(() => <ScrobblingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Finish connecting/ }));
    expect(await screen.findByText('Connected as ana_fm')).toBeInTheDocument();
  });

  it('pauses a service without disconnecting it', async () => {
    engine({
      'GET /api/scrobble': status({ listenbrainz: CONNECTED }),
      'PATCH /api/scrobble/listenbrainz': status({ listenbrainz: { ...CONNECTED, enabled: false } }),
    });
    render(() => <ScrobblingPanel />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Send what I play' }));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Send what I play' })).toHaveAttribute('aria-checked', 'false'),
    );
    expect(called('PATCH /api/scrobble/listenbrainz')[0][1].body).toEqual({ enabled: false });
  });

  it('shows what is waiting and why, and can retry at once', async () => {
    const waiting = { ...CONNECTED, state: 'retrying' as const, pending: 4, error: 'http_503', last_sent_at: 1_700_000_000 };
    engine({
      'GET /api/scrobble': status({ listenbrainz: waiting }),
      'POST /api/scrobble/listenbrainz/retry': status({ listenbrainz: { ...CONNECTED, last_sent_at: 1_700_000_500 } }),
    });
    render(() => <ScrobblingPanel />);
    expect(await screen.findByText('ListenBrainz is not answering. Waiting to be sent: 4')).toBeInTheDocument();
    expect(screen.queryByText('Never')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again now' }));
    expect(await screen.findByText('Up to date')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again now' })).not.toBeInTheDocument();
  });

  it('asks to connect again when access was revoked', async () => {
    engine({
      'GET /api/scrobble': status({ listenbrainz: { ...CONNECTED, state: 'reconnect', pending: 2, error: 'token_rejected' } }),
      'PUT /api/scrobble/listenbrainz': status({ listenbrainz: CONNECTED }),
    });
    promptMock.mockResolvedValueOnce('new-token');
    render(() => <ScrobblingPanel />);
    expect(await screen.findByText('Access was revoked. Waiting to be sent: 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Connect again/ }));
    expect(await screen.findByText('Up to date')).toBeInTheDocument();
  });

  it('warns about unsent plays before disconnecting', async () => {
    engine({
      'GET /api/scrobble': status({ listenbrainz: { ...CONNECTED, pending: 3 } }),
      'DELETE /api/scrobble/listenbrainz': status(),
    });
    confirmMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(() => <ScrobblingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /^Disconnect/ }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(confirmMock.mock.calls[0][0]).toMatchObject({
      title: 'Disconnect ListenBrainz?',
      message: 'Plays not sent yet: 3. They are discarded. What was already sent stays on the service.',
      danger: true,
    });
    expect(called('DELETE /api/scrobble/listenbrainz')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /^Disconnect/ }));
    expect(await screen.findByRole('button', { name: /Connect ListenBrainz/ })).toBeInTheDocument();
  });

  it('lets an admin add and remove the Last.fm API key, unless the environment set it', async () => {
    const admin = (lastfm_app: ScrobbleStatus['lastfm_app'], available: boolean) =>
      status({ lastfm: { available } }, { custom_servers: true, lastfm_app });
    engine({
      'GET /api/scrobble': admin({ configured: false, from_environment: false }, false),
      'PUT /api/scrobble/lastfm/app': admin({ configured: true, from_environment: false }, true),
      'DELETE /api/scrobble/lastfm/app': admin({ configured: false, from_environment: false }, false),
    });
    promptMock.mockResolvedValueOnce('api-key').mockResolvedValueOnce('shared-secret');
    const view = render(() => <ScrobblingPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Add a Last.fm API key/ }));
    expect(await screen.findByRole('button', { name: /Connect Last\.fm/ })).toBeInTheDocument();
    expect(called('PUT /api/scrobble/lastfm/app')[0][1].body).toEqual({ api_key: 'api-key', api_secret: 'shared-secret' });

    fireEvent.click(screen.getByRole('button', { name: 'Remove the API key' }));
    expect(await screen.findByRole('button', { name: /Add a Last.fm API key/ })).toBeInTheDocument();
    view.unmount();

    engine({ 'GET /api/scrobble': admin({ configured: true, from_environment: true }, true) });
    render(() => <ScrobblingPanel />);
    expect(await screen.findByText('Set in the environment')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove the API key' })).not.toBeInTheDocument();
  });
});
