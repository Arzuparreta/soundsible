import { createSignal } from 'solid-js';
import { io, type Socket } from 'socket.io-client';
import { ApiError, request } from './api';
import {
  openCommunityListener,
  openCommunityPublisher,
  type CommunityPeerHandle,
} from './communityWebrtc';

export type LiveSessionStatus = 'waiting' | 'live' | 'reconnecting';
export type LiveTransport = 'playing' | 'paused';

export interface LiveDeck {
  id: string;
  title: string;
  artist: string;
  artwork_url?: string | null;
  position: number;
  duration: number;
  gain: number;
}

export interface LiveTransition {
  technique: string;
  phase: string;
  progress: number;
  dominant: boolean;
}

export interface LiveProgram {
  v: 1;
  seq: number;
  emitted_at: number;
  program_time: number;
  transport: LiveTransport;
  primary: LiveDeck | null;
  secondary: LiveDeck | null;
  transition: LiveTransition | null;
}

export interface LiveSession {
  id: string;
  status: LiveSessionStatus;
  title: string;
  host: {
    id: string;
    display_name: string;
    avatar_color?: string | null;
  };
  created_at: number;
  updated_at: number;
  listener_count: number;
  program?: LiveProgram | null;
  whep_url: string;
}

export interface HostLiveSession extends LiveSession {
  host_token: string;
  publish_token: string;
  whip_url: string;
  socket_url: string;
  stream_path: string;
  reconnect_grace_seconds: number;
}

export interface LiveChatMessage {
  id: string;
  session_id: string;
  sender: {
    kind: 'host' | 'guest';
    id: string;
    display_name: string;
    avatar_color?: string | null;
  };
  text: string;
  sent_at: number;
}

export type CommunitySource = 'official' | 'custom' | 'disabled';
export type CommunityState = 'available' | 'disabled' | 'invalid' | 'unavailable';
export type CommunityIssue =
  | 'loading'
  | 'disabled'
  | 'invalid'
  | 'unavailable'
  | 'capacity'
  | 'secure_context'
  | 'reconnecting'
  | 'publish_failed'
  | 'listen_failed';
export type MediaConnectionState = 'idle' | 'connecting' | 'connected' | 'recovering' | 'failed';

export interface CommunityConfig {
  enabled: boolean;
  api_url: string | null;
  source: CommunitySource;
  state: CommunityState;
  error?: { code: string; message: string } | null;
  identity?: { community_id: string } | null;
  secure_url?: string | null;
}

const ACTIVE_HOST_KEY = 'community:active-host:v1';
const GUEST_ID_KEY = 'community:guest-id:v1';

const [config, setConfig] = createSignal<CommunityConfig | null>(null);
const [sessions, setSessions] = createSignal<LiveSession[]>([]);
const [hostSession, setHostSession] = createSignal<HostLiveSession | null>(null);
const [joinedSession, setJoinedSession] = createSignal<LiveSession | null>(null);
const [program, setProgram] = createSignal<LiveProgram | null>(null);
const [messages, setMessages] = createSignal<LiveChatMessage[]>([]);
const [listenerStream, setListenerStream] = createSignal<MediaStream | null>(null);
const [communityError, setCommunityError] = createSignal<CommunityIssue | null>(null);
const [publisherConnected, setPublisherConnected] = createSignal(false);
const [publisherState, setPublisherState] = createSignal<MediaConnectionState>('idle');
const [listenerState, setListenerState] = createSignal<MediaConnectionState>('idle');

export {
  config as communityConfig,
  sessions as liveSessions,
  hostSession,
  joinedSession,
  program as liveProgram,
  messages as liveMessages,
  listenerStream,
  communityError,
  publisherConnected,
  publisherState,
  listenerState,
};

let socket: Socket | null = null;
let publisher: CommunityPeerHandle | null = null;
let listener: CommunityPeerHandle | null = null;
let listenerStatsTimer: number | undefined;
let playoutDelayMs = 120;
let programTimer: number | undefined;
let publisherRetryTimer: number | undefined;
let listenerRetryTimer: number | undefined;
let publisherSource: MediaStream | null = null;
let publisherGeneration = 0;
let listenerGeneration = 0;
let publisherRecoveryDeadline = 0;
let listenerRecoveryDeadline = 0;
let publisherRetryAttempt = 0;
let listenerRetryAttempt = 0;
let listenerAuthorized = false;

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

function activeHostId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_HOST_KEY);
  } catch {
    return null;
  }
}

function rememberHost(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_HOST_KEY, id);
    else localStorage.removeItem(ACTIVE_HOST_KEY);
  } catch {
    /* private mode */
  }
}

function guestIdentity(): { id: string; name: string } {
  let id = '';
  try {
    id = localStorage.getItem(GUEST_ID_KEY) ?? '';
  } catch {
    /* private mode */
  }
  if (!id) {
    const bytes = new Uint8Array(5);
    crypto.getRandomValues(bytes);
    id = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    try {
      localStorage.setItem(GUEST_ID_KEY, id);
    } catch {
      /* private mode */
    }
  }
  return { id: `guest-${id}`, name: `Guest-${id.slice(-4).toUpperCase()}` };
}

function issueForConfig(value: CommunityConfig): CommunityIssue | null {
  if (value.state === 'disabled') return 'disabled';
  if (value.state === 'invalid') return 'invalid';
  if (value.state === 'unavailable') return 'unavailable';
  return null;
}

export async function loadCommunityConfig(force = false): Promise<CommunityConfig> {
  const current = config();
  if (current && !force) return current;
  const loaded = await request<CommunityConfig>('/api/community/config');
  setConfig(loaded);
  setCommunityError(issueForConfig(loaded));
  return loaded;
}

async function publicRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const current = await loadCommunityConfig();
  if (!current.enabled || !current.api_url) throw new Error('community_disabled');
  const response = await fetch(`${current.api_url}${path}`, options);
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { code?: string } | null;
    throw new ApiError(response.status, `Community ${path} → ${response.status}`, payload?.code, payload);
  }
  return response.json() as Promise<T>;
}

function issueForError(error: unknown, fallback: CommunityIssue): CommunityIssue {
  if (error instanceof ApiError && error.code === 'session_capacity') return 'capacity';
  if (error instanceof ApiError && error.code === 'community_disabled') return 'disabled';
  if (error instanceof ApiError && error.code === 'community_invalid_url') return 'invalid';
  return fallback;
}

function mergeSession(next: LiveSession): void {
  setSessions((current) => {
    const found = current.findIndex((session) => session.id === next.id);
    if (found === -1) return [next, ...current];
    const copy = current.slice();
    copy[found] = next;
    return copy;
  });
  if (joinedSession()?.id === next.id) {
    setJoinedSession(next);
    if (next.program) setProgram(next.program);
  }
  if (hostSession()?.id === next.id) {
    setHostSession((current) => current ? { ...current, ...next } : current);
  }
}

function connectSocket(session: LiveSession, host?: HostLiveSession): void {
  socket?.disconnect();
  const guest = guestIdentity();
  const endpoint = host?.socket_url || config()?.api_url;
  if (!endpoint) return;
  socket = io(endpoint, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 8,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 8000,
    auth: host
      ? { session_id: session.id, host_token: host.host_token }
      : { session_id: session.id, guest_id: guest.id, guest_name: guest.name },
  });
  socket.on('session_snapshot', ({ session: next }: { session: LiveSession }) => {
    mergeSession(next);
    if (next.program) setProgram(next.program);
  });
  socket.on('session_updated', ({ session: next }: { session: LiveSession }) => mergeSession(next));
  socket.on('presence', ({ session_id, listener_count }: { session_id: string; listener_count: number }) => {
    setSessions((current) => current.map((item) => (
      item.id === session_id ? { ...item, listener_count } : item
    )));
    if (joinedSession()?.id === session_id) {
      setJoinedSession((current) => current ? { ...current, listener_count } : current);
    }
    if (hostSession()?.id === session_id) {
      setHostSession((current) => current ? { ...current, listener_count } : current);
    }
  });
  socket.on('program_event', (next: LiveProgram) => {
    if ((program()?.seq ?? -1) >= next.seq) return;
    if (host || !listener) {
      setProgram(next);
      return;
    }
    window.clearTimeout(programTimer);
    programTimer = window.setTimeout(() => setProgram(next), playoutDelayMs);
  });
  socket.on('chat_message', (message: LiveChatMessage) => {
    setMessages((current) => [...current, message]);
  });
  socket.on('session_ended', ({ session_id }: { session_id: string }) => {
    setSessions((current) => current.filter((item) => item.id !== session_id));
    if (joinedSession()?.id === session_id) void leaveLiveSession();
    if (hostSession()?.id === session_id) void clearHostState();
  });
  socket.on('connect_error', () => setCommunityError('reconnecting'));
  socket.io.on('reconnect_attempt', () => setCommunityError('reconnecting'));
  socket.io.on('reconnect_failed', () => setCommunityError('unavailable'));
  socket.on('connect', () => {
    const current = config();
    setCommunityError(current ? issueForConfig(current) : null);
  });
}

export async function initCommunity(): Promise<void> {
  setCommunityError('loading');
  try {
    const current = await loadCommunityConfig(true);
    if (!current.enabled) return;
    await refreshLiveSessions();
    const previousId = activeHostId();
    if (previousId) {
      try {
        const resumed = await request<{ session: HostLiveSession }>(
          `/api/community/sessions/${encodeURIComponent(previousId)}/resume`,
          { method: 'POST', timeoutMs: 15000 },
        );
        setHostSession(resumed.session);
        setProgram(resumed.session.program ?? null);
        setMessages([]);
        connectSocket(resumed.session, resumed.session);
      } catch {
        rememberHost(null);
      }
    }
  } catch {
    setCommunityError('unavailable');
  }
}

/** The shell calls this once, but it remains completely local unless a room id
 * proves that this device has a broadcast to recover. */
export async function resumeCommunityIfActive(): Promise<void> {
  if (!activeHostId()) return;
  await initCommunity();
}

export async function retryCommunity(): Promise<void> {
  setCommunityError('loading');
  setConfig(null);
  await initCommunity();
}

export async function refreshLiveSessions(): Promise<LiveSession[]> {
  try {
    const response = await publicRequest<{ sessions: LiveSession[] }>('/v1/sessions');
    setSessions(response.sessions ?? []);
    setCommunityError(null);
    return response.sessions ?? [];
  } catch {
    setCommunityError('unavailable');
    return [];
  }
}

export async function createHostSession(title: string): Promise<HostLiveSession> {
  try {
    let response: { session: HostLiveSession };
    try {
      response = await request<{ session: HostLiveSession }>('/api/community/sessions', {
        method: 'POST',
        body: { title },
        timeoutMs: 15000,
      });
    } catch (error) {
      const payload = error instanceof ApiError
        ? error.payload as { session_id?: string } | undefined
        : undefined;
      if (error instanceof ApiError && error.code === 'session_already_active' && payload?.session_id) {
        response = await request<{ session: HostLiveSession }>(
          `/api/community/sessions/${encodeURIComponent(payload.session_id)}/resume`,
          { method: 'POST', timeoutMs: 15000 },
        );
      } else {
        throw error;
      }
    }
    setHostSession(response.session);
    setProgram(null);
    setMessages([]);
    rememberHost(response.session.id);
    mergeSession(response.session);
    connectSocket(response.session, response.session);
    setCommunityError(null);
    return response.session;
  } catch (error) {
    setCommunityError(issueForError(error, 'unavailable'));
    throw error;
  }
}

/** Browsers hide usable ICE candidates on non-trustworthy HTTP origins. */
export function liveMediaSecure(): boolean {
  return typeof window === 'undefined' || window.isSecureContext !== false;
}

export async function updateHostTitle(title: string): Promise<void> {
  const session = hostSession();
  if (!session) return;
  const response = await request<{ session: LiveSession }>(
    `/api/community/sessions/${encodeURIComponent(session.id)}`,
    { method: 'PATCH', body: { title }, timeoutMs: 12000 },
  );
  mergeSession(response.session);
}

function closePeer(handle: CommunityPeerHandle | null): void {
  if (!handle) return;
  handle.close();
}

function clearPublisherRetry(): void {
  window.clearTimeout(publisherRetryTimer);
  publisherRetryTimer = undefined;
}

function clearListenerRetry(): void {
  window.clearTimeout(listenerRetryTimer);
  listenerRetryTimer = undefined;
}

function musicOffer(sdp: string | undefined): string | undefined {
  if (!sdp) return sdp;
  const match = /^a=rtpmap:(\d+) opus\/48000\/2$/m.exec(sdp);
  if (!match) return sdp;
  const payload = match[1];
  const fmtp = new RegExp(`^a=fmtp:${payload} (.*)$`, 'm');
  const options = 'stereo=1;sprop-stereo=1;usedtx=0;useinbandfec=1;maxaveragebitrate=192000';
  return fmtp.test(sdp)
    ? sdp.replace(fmtp, (_line, current: string) => `a=fmtp:${payload} ${current};${options}`)
    : sdp.replace(match[0], `${match[0]}\r\na=fmtp:${payload} ${options}`);
}

async function clearHostState(): Promise<void> {
  publisherGeneration += 1;
  clearPublisherRetry();
  closePeer(publisher);
  publisher = null;
  publisherSource = null;
  publisherRetryAttempt = 0;
  setPublisherConnected(false);
  setPublisherState('idle');
  socket?.disconnect();
  socket = null;
  rememberHost(null);
  setHostSession(null);
  setProgram(null);
  setMessages([]);
}

export async function endHostSession(): Promise<void> {
  const session = hostSession();
  await clearHostState();
  if (session) {
    await request<void>(`/api/community/sessions/${encodeURIComponent(session.id)}`, {
      method: 'DELETE',
      timeoutMs: 12000,
    }).catch(() => setCommunityError('unavailable'));
  }
}

async function establishHostPublisher(stream: MediaStream, generation: number): Promise<void> {
  const session = hostSession();
  if (!session || generation !== publisherGeneration) return;
  setPublisherState(publisherRetryAttempt > 0 ? 'recovering' : 'connecting');
  const handle = await openCommunityPublisher({
    endpoint: session.whip_url,
    token: session.publish_token,
    stream,
    transformOffer: musicOffer,
    onTransportError: () => schedulePublisherRecovery(generation),
  });
  const { pc } = handle;
  if (generation !== publisherGeneration) {
    handle.close();
    return;
  }
  publisher = handle;
  pc.addEventListener('connectionstatechange', () => {
    if (generation !== publisherGeneration || publisher?.pc !== pc) return;
    const connected = pc.connectionState === 'connected';
    setPublisherConnected(connected);
    if (connected) {
      publisherRetryAttempt = 0;
      setPublisherState('connected');
      if (communityError() === 'publish_failed' || communityError() === 'reconnecting') {
        setCommunityError(null);
      }
    }
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      publisher = null;
      handle.close();
      setPublisherConnected(false);
      schedulePublisherRecovery(generation);
    } else if (pc.connectionState === 'disconnected') {
      schedulePublisherRecovery(generation);
    }
  });
  if (pc.connectionState === 'connected') {
    publisherRetryAttempt = 0;
    setPublisherConnected(true);
    setPublisherState('connected');
    setCommunityError(null);
  } else {
    setPublisherConnected(false);
  }
}

function schedulePublisherRecovery(generation: number): void {
  if (generation !== publisherGeneration || publisherRetryTimer !== undefined || !publisherSource) return;
  if (publisherRetryAttempt === 0 && publisherState() === 'connected') {
    publisherRecoveryDeadline = Date.now() + (hostSession()?.reconnect_grace_seconds ?? 90) * 1000;
  }
  if (Date.now() >= publisherRecoveryDeadline) {
    setPublisherState('failed');
    setCommunityError('publish_failed');
    return;
  }
  setPublisherState('recovering');
  setCommunityError('reconnecting');
  const delay = RETRY_DELAYS_MS[Math.min(publisherRetryAttempt, RETRY_DELAYS_MS.length - 1)];
  publisherRetryAttempt += 1;
  publisherRetryTimer = window.setTimeout(() => {
    publisherRetryTimer = undefined;
    if (generation !== publisherGeneration || !publisherSource) return;
    const previous = publisher;
    publisher = null;
    closePeer(previous);
    void establishHostPublisher(publisherSource, generation).catch(() => schedulePublisherRecovery(generation));
  }, delay);
}

export async function startHostPublisher(stream: MediaStream): Promise<void> {
  if (!hostSession()) return;
  if (!liveMediaSecure()) {
    setPublisherState('failed');
    setCommunityError('secure_context');
    throw new Error('community_secure_context_required');
  }
  publisherSource = stream;
  if (publisher || publisherState() === 'connecting' || publisherState() === 'recovering') return;
  publisherGeneration += 1;
  const generation = publisherGeneration;
  publisherRecoveryDeadline = Date.now() + (hostSession()?.reconnect_grace_seconds ?? 90) * 1000;
  publisherRetryAttempt = 0;
  clearPublisherRetry();
  try {
    await establishHostPublisher(stream, generation);
  } catch (error) {
    schedulePublisherRecovery(generation);
    throw error;
  }
}

export async function retryHostPublisher(): Promise<void> {
  if (!publisherSource || !hostSession()) return;
  publisherGeneration += 1;
  const generation = publisherGeneration;
  clearPublisherRetry();
  closePeer(publisher);
  publisher = null;
  publisherRetryAttempt = 0;
  publisherRecoveryDeadline = Date.now() + (hostSession()?.reconnect_grace_seconds ?? 90) * 1000;
  setCommunityError(null);
  try {
    await establishHostPublisher(publisherSource, generation);
  } catch (error) {
    schedulePublisherRecovery(generation);
    throw error;
  }
}

export function sendProgramEvent(next: LiveProgram): void {
  if (!hostSession() || !socket?.connected) return;
  socket.emit('program_event', next);
  setProgram(next);
}

async function resizedArtwork(sourceUrl: string): Promise<Blob | null> {
  const response = await fetch(sourceUrl);
  if (!response.ok) return null;
  const source = await response.blob();
  if (!source.type.startsWith('image/')) return null;
  try {
    const bitmap = await createImageBitmap(source);
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const output = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.8));
    return output && output.size <= 256 * 1024 ? output : null;
  } catch {
    return source.size <= 256 * 1024 ? source : null;
  }
}

export async function uploadHostArtwork(trackId: string, sourceUrl: string): Promise<string | null> {
  const session = hostSession();
  if (!session) return null;
  const artwork = await resizedArtwork(sourceUrl);
  if (!artwork) return null;
  const form = new FormData();
  form.append('track_id', trackId);
  form.append('artwork', artwork, `cover.${artwork.type === 'image/webp' ? 'webp' : 'jpg'}`);
  const response = await fetch(
    `${config()?.api_url}/v1/sessions/${encodeURIComponent(session.id)}/artwork`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.host_token}` },
      body: form,
    },
  );
  if (!response.ok) return null;
  const payload = await response.json() as { artwork_url?: string };
  return payload.artwork_url ?? null;
}

export function sendChatMessage(text: string): void {
  const clean = text.trim();
  if (!clean || clean.length > 500 || !socket?.connected) return;
  socket.emit('chat_message', { text: clean });
}

export function joinLiveSession(session: LiveSession): void {
  listenerGeneration += 1;
  clearListenerRetry();
  closePeer(listener);
  listener = null;
  listenerAuthorized = false;
  listenerRetryAttempt = 0;
  setListenerState('idle');
  socket?.disconnect();
  setJoinedSession(session);
  setProgram(session.program ?? null);
  setMessages([]);
  setListenerStream(null);
  connectSocket(session);
}

function startListenerStats(pc: RTCPeerConnection): void {
  window.clearInterval(listenerStatsTimer);
  listenerStatsTimer = window.setInterval(() => {
    void pc.getStats().then((report) => {
      report.forEach((stat) => {
        if (stat.type !== 'inbound-rtp' || stat.kind !== 'audio') return;
        if (typeof stat.estimatedPlayoutTimestamp === 'number' && typeof stat.timestamp === 'number') {
          const estimate = stat.estimatedPlayoutTimestamp - stat.timestamp;
          if (estimate >= 0 && estimate < 2000) playoutDelayMs = estimate;
        } else if (stat.jitterBufferEmittedCount > 0) {
          const estimate = (stat.jitterBufferDelay / stat.jitterBufferEmittedCount) * 1000;
          if (Number.isFinite(estimate)) playoutDelayMs = Math.min(1000, Math.max(20, estimate + 20));
        }
      });
    }).catch(() => {});
  }, 1000);
}

async function establishListener(generation: number): Promise<MediaStream> {
  const session = joinedSession();
  if (!session || generation !== listenerGeneration) throw new Error('session_missing');
  setListenerState(listenerRetryAttempt > 0 ? 'recovering' : 'connecting');
  const incoming = new MediaStream();
  const handle = await openCommunityListener({
    endpoint: session.whep_url,
    onTrack: (event) => {
      for (const track of event.streams[0]?.getTracks() ?? [event.track]) incoming.addTrack(track);
      setListenerStream(incoming);
    },
    onTransportError: () => scheduleListenerRecovery(generation),
  });
  const { pc } = handle;
  if (generation !== listenerGeneration) {
    handle.close();
    throw new Error('listener_superseded');
  }
  listener = handle;
  pc.addEventListener('connectionstatechange', () => {
    if (generation !== listenerGeneration || listener?.pc !== pc) return;
    if (pc.connectionState === 'connected') {
      listenerRetryAttempt = 0;
      setListenerState('connected');
      if (communityError() === 'listen_failed' || communityError() === 'reconnecting') {
        setCommunityError(null);
      }
    } else if (
      pc.connectionState === 'failed'
      || pc.connectionState === 'closed'
      || pc.connectionState === 'disconnected'
    ) {
      listener = null;
      if (pc.connectionState !== 'disconnected') handle.close();
      scheduleListenerRecovery(generation);
    }
  });
  if (pc.connectionState === 'connected') {
    listenerRetryAttempt = 0;
    setListenerState('connected');
    setCommunityError(null);
  }
  startListenerStats(pc);
  return incoming;
}

function scheduleListenerRecovery(generation: number): void {
  if (
    generation !== listenerGeneration
    || listenerRetryTimer !== undefined
    || !listenerAuthorized
    || !joinedSession()
  ) return;
  if (listenerRetryAttempt === 0 && listenerState() === 'connected') {
    listenerRecoveryDeadline = Date.now() + 90_000;
  }
  if (Date.now() >= listenerRecoveryDeadline) {
    setListenerState('failed');
    setCommunityError('listen_failed');
    return;
  }
  setListenerState('recovering');
  setCommunityError('reconnecting');
  const delay = RETRY_DELAYS_MS[Math.min(listenerRetryAttempt, RETRY_DELAYS_MS.length - 1)];
  listenerRetryAttempt += 1;
  listenerRetryTimer = window.setTimeout(() => {
    listenerRetryTimer = undefined;
    if (generation !== listenerGeneration || !listenerAuthorized) return;
    const previous = listener;
    listener = null;
    closePeer(previous);
    window.clearInterval(listenerStatsTimer);
    setListenerStream(null);
    void establishListener(generation).catch(() => scheduleListenerRecovery(generation));
  }, delay);
}

export async function startListening(): Promise<MediaStream> {
  if (!joinedSession()) throw new Error('session_missing');
  if (!liveMediaSecure()) {
    setListenerState('failed');
    setCommunityError('secure_context');
    throw new Error('community_secure_context_required');
  }
  if (listenerStream() && listenerState() !== 'failed') return listenerStream()!;
  listenerAuthorized = true;
  listenerGeneration += 1;
  const generation = listenerGeneration;
  listenerRecoveryDeadline = Date.now() + 90_000;
  listenerRetryAttempt = 0;
  clearListenerRetry();
  closePeer(listener);
  listener = null;
  try {
    return await establishListener(generation);
  } catch (error) {
    scheduleListenerRecovery(generation);
    throw error;
  }
}

export async function retryListening(): Promise<MediaStream> {
  setCommunityError(null);
  return startListening();
}

export async function leaveLiveSession(): Promise<void> {
  listenerGeneration += 1;
  listenerAuthorized = false;
  clearListenerRetry();
  closePeer(listener);
  listener = null;
  window.clearInterval(listenerStatsTimer);
  window.clearTimeout(programTimer);
  socket?.disconnect();
  socket = null;
  setJoinedSession(null);
  setProgram(null);
  setMessages([]);
  setListenerStream(null);
  setListenerState('idle');
}

/** Keeps Vitest cases isolated without exposing private identity or tokens. */
export async function resetCommunityStateForTests(): Promise<void> {
  await clearHostState();
  await leaveLiveSession();
  setConfig(null);
  setSessions([]);
  setCommunityError(null);
  rememberHost(null);
}
