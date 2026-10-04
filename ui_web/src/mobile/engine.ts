import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { setRequestTransport } from '../lib/http';
import { setResourceOrigin } from '../lib/config';

export interface EngineState { origin: string; generation: number }
interface NativeResponse { status: number; body: string; headers: Record<string, string> }
interface Part { name: string; value?: string; filename?: string; type?: string; base64?: string; importToken?: string }
interface EnginePlugin {
  state(): Promise<EngineState>;
  configure(options: { origin: string }): Promise<EngineState>;
  clear(options: { forget: boolean }): Promise<EngineState>;
  request(options: { generation: number; id: string; path: string; method: string; headers: Record<string, string>; body?: string; parts?: Part[]; timeoutMs: number }): Promise<NativeResponse>;
  cancel(options: { id: string }): Promise<void>;
  events(options: { generation: number }): Promise<void>;
  stopEvents(): Promise<void>;
  addListener(event: 'engineEvent', callback: (data: { event: string; generation: number }) => void): Promise<PluginListenerHandle>;
}
export const engine = registerPlugin<EnginePlugin>('SoundsibleEngine');
let active: EngineState = { origin: '', generation: -1 };
let counter = 0;
export function useEngine(next: EngineState): void {
  active = next;
  setResourceOrigin(`${window.location.origin}/__engine/${next.generation}`, next.origin);
  setRequestTransport(nativeFetch);
}
const importBodies = new WeakMap<FormData, string>();
/** Only an OS-selected native token can bypass the ordinary File/base64 adapter. */
export function nativeImportBody(token: string): FormData {
  const body = new FormData(); importBodies.set(body, token); return body;
}
function aborted(): DOMException { return new DOMException('Request aborted', 'AbortError'); }
async function multipart(form: FormData): Promise<Part[]> {
  const token = importBodies.get(form);
  if (token) return [{ name: 'file', importToken: token }];
  return Promise.all([...form.entries()].map(async ([name, value]) => {
    if (typeof value === 'string') return { name, value };
    const bytes = new Uint8Array(await value.arrayBuffer());
    // Avoid spread exceeding the JS argument limit on a large artwork file.
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return { name, filename: value.name, type: value.type || 'application/octet-stream', base64: btoa(binary) };
  }));
}
async function nativeFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const snapshot = active;
  const id = `rest-${++counter}`;
  const signal = init.signal;
  if (signal?.aborted) throw aborted();
  const path = new URL(url).pathname + new URL(url).search;
  if (!snapshot.origin || !path.startsWith('/api/')) throw new Error('Select a server first');
  const parts = init.body instanceof FormData ? await multipart(init.body) : undefined;
  if (signal?.aborted || active !== snapshot) throw aborted();
  return new Promise<Response>((resolve, reject) => {
    const cancel = () => { void engine.cancel({ id }); reject(aborted()); };
    signal?.addEventListener('abort', cancel, { once: true });
    void engine.request({ id, generation: snapshot.generation, path,
      method: init.method || 'GET', headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === 'string' ? init.body : undefined, parts, timeoutMs,
    }).then(result => {
      if (signal?.aborted || active !== snapshot) throw aborted();
      resolve(new Response([204, 304].includes(result.status) ? null : result.body,
        { status: result.status, headers: result.headers }));
    }).catch(reject).finally(() => signal?.removeEventListener('abort', cancel));
  });
}
export async function watchEngine(callback: (event: string) => void): Promise<() => void> {
  const snapshot = active;
  const listener = await engine.addListener('engineEvent', event => {
    if (active === snapshot && event.generation === snapshot.generation) callback(event.event);
  });
  try { await engine.events({ generation: snapshot.generation }); }
  catch (error) { await listener.remove(); throw error; }
  return () => { void listener.remove(); if (active === snapshot) void engine.stopEvents(); };
}
