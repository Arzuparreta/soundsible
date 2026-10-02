import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, request, setRequestTransport, setUnauthorizedHandler } from '../lib/http';
import { setResourceOrigin } from '../lib/config';
const native = vi.hoisted(() => ({ request: vi.fn(), cancel: vi.fn(), events: vi.fn(), stopEvents: vi.fn(), addListener: vi.fn() }));
vi.mock('@capacitor/core', () => ({ registerPlugin: () => native }));
import { useEngine, watchEngine } from './engine';

beforeEach(() => {
  vi.clearAllMocks();
  useEngine({ origin: 'http://10.0.2.2:5097', generation: 1 });
  native.request.mockResolvedValue({ status: 200, body: '{"ok":true}', headers: { ETag: '"revision"' } });
  native.cancel.mockResolvedValue(undefined);
});
afterEach(() => { setRequestTransport(null); setResourceOrigin(null); setUnauthorizedHandler(null); });
describe('native account transport', () => {
  it('carries JSON/validators through native networking without JS session credentials', async () => {
    const etag = vi.fn();
    expect(await request('/api/library', { ifNoneMatch: '"old"', onETag: etag })).toEqual({ ok: true });
    expect(native.request.mock.calls[0][0]).toMatchObject({ path: '/api/library', generation: 1, headers: { 'if-none-match': '"old"' }, timeoutMs: 8000 });
    expect(native.request.mock.calls[0][0].headers).not.toHaveProperty('cookie');
    expect(etag).toHaveBeenCalledWith('"revision"');
    await request('/api/auth/login', { method: 'POST', body: { username: 'member', password: 'synthetic' } });
    expect(native.request.mock.calls[1][0].body).toBe('{"username":"member","password":"synthetic"}');
  });
  it('preserves conditional 304 and distinguishes permission denial from expired identity', async () => {
    const unauthorized = vi.fn(); setUnauthorizedHandler(unauthorized);
    native.request.mockResolvedValueOnce({ status: 304, body: '', headers: {} });
    expect(await request('/api/library', { ifNoneMatch: '"rev"' })).toBeNull();
    native.request.mockResolvedValueOnce({ status: 403, body: '{"code":"member"}', headers: {} });
    await expect(request('/api/users')).rejects.toMatchObject({ status: 403, code: 'member' });
    expect(unauthorized).not.toHaveBeenCalled();
    native.request.mockResolvedValueOnce({ status: 401, body: '{}', headers: {} });
    await expect(request('/api/library')).rejects.toBeInstanceOf(ApiError);
    expect(unauthorized).toHaveBeenCalledOnce();
  });
  it('cancels native work on abort and never accepts a late account response', async () => {
    let complete!: (data: unknown) => void;
    native.request.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const controller = new AbortController();
    const pending = request('/api/library', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(native.cancel).toHaveBeenCalledOnce();
    complete({ status: 200, body: '{"oldAccount":true}', headers: {} });
    native.request.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const old = request('/api/library');
    useEngine({ origin: 'https://another.example', generation: 2 });
    complete({ status: 200, body: '{"oldAccount":true}', headers: {} });
    await expect(old).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('serializes multipart fields without inventing a JSON Content-Type', async () => {
    const form = new FormData(); form.append('title', 'Cover');
    await request('/api/library/cover', { method: 'POST', body: form });
    expect(native.request.mock.calls[0][0].parts).toEqual([{ name: 'title', value: 'Cover' }]);
    expect(native.request.mock.calls[0][0].headers).not.toHaveProperty('content-type');
  });
  it('keeps binary multipart bytes, filename and MIME separate from JSON', async () => {
    const form = new FormData();
    const file = new File([new Uint8Array([1, 2, 3])], 'art.png', { type: 'image/png' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([1, 2, 3]).buffer });
    form.append('cover', file);
    await request('/api/library/cover', { method: 'POST', body: form });
    expect(native.request.mock.calls[0][0].parts).toEqual([{ name: 'cover', filename: 'art.png', type: 'image/png', base64: 'AQID' }]);
  });
  it('enforces the shared timeout even when native networking has not answered', async () => {
    vi.useFakeTimers();
    try {
      native.request.mockImplementationOnce(() => new Promise(() => undefined));
      const pending = expect(request('/api/library', { timeoutMs: 50 })).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(50); await pending;
      expect(native.cancel).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it('ignores old generation socket events and removes the listener on disposal', async () => {
    let deliver!: (event: { event: string; generation: number }) => void;
    const remove = vi.fn().mockResolvedValue(undefined);
    native.addListener.mockImplementation(async (_event, callback) => { deliver = callback; return { remove }; });
    const received = vi.fn();
    const stop = await watchEngine(received);
    deliver({ event: 'library_updated', generation: 1 });
    expect(received).toHaveBeenCalledOnce();
    useEngine({ origin: 'https://another.example', generation: 2 });
    deliver({ event: 'library_updated', generation: 1 });
    expect(received).toHaveBeenCalledOnce();
    stop(); expect(remove).toHaveBeenCalledOnce(); expect(native.stopEvents).not.toHaveBeenCalled();
  });
});
