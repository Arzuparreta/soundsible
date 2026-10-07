import { apiOrigin, ownerToken } from './config';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly payload?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  keepalive?: boolean;
  ifNoneMatch?: string;
  onETag?: (etag: string | null) => void;
  cache?: RequestCache;
}

/** Notified whenever the engine answers 401 — the app shows the login screen. */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

export type RequestTransport = (url: string, init: RequestInit, timeoutMs: number) => Promise<Response>;
let requestTransport: RequestTransport | null = null;
/** Installed once by the native entry; the browser keeps its existing fetch. */
export function setRequestTransport(transport: RequestTransport | null): void { requestTransport = transport; }

/** Typed fetch wrapper over the engine REST contract. Reuses the timeout/abort
 * pattern from the legacy http.js, adds JSON + owner-token handling. */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, timeoutMs = 8000 } = opts;
  // One controller drives the fetch so both reasons to give up work together.
  // Handing the caller's signal straight to `fetch` (the old shape) meant any
  // request that supplied one — every debounced search — silently lost its
  // timeout and could hang until the browser gave up on its own.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const external = opts.signal;
  const abortFromCaller = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', abortFromCaller, { once: true });
  }
  const headers: Record<string, string> = {};
  if (opts.ifNoneMatch) headers['If-None-Match'] = opts.ifNoneMatch;
  // FormData sets its own multipart Content-Type (with boundary); JSON we set explicitly.
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  const token = ownerToken();
  if (token) headers['X-Soundsible-Admin-Token'] = token;

  try {
    const res = await (requestTransport ?? ((url, init) => fetch(url, init)))(`${apiOrigin()}${path}`, {
      method,
      headers,
      // The session lives in an HttpOnly cookie, so every call has to carry it.
      credentials: 'same-origin',
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
      signal: controller.signal,
      keepalive: opts.keepalive,
      cache: opts.cache,
    }, timeoutMs);
    if (res.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized?.();
    if (res.status === 304 && opts.ifNoneMatch) return null as T;
    if (!res.ok) {
      const text = await res.text();
      let payload: unknown;
      try {
        payload = text ? JSON.parse(text) : undefined;
      } catch {
        payload = text || undefined;
      }
      const code = payload && typeof payload === 'object' && 'code' in payload
        ? String((payload as { code?: unknown }).code || '')
        : undefined;
      throw new ApiError(res.status, `${method} ${path} → ${res.status}`, code, payload);
    }
    opts.onETag?.(res.headers.get('ETag'));
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', abortFromCaller);
  }
}

