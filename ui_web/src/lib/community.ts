import { createSignal } from 'solid-js';
import { io, type Socket } from 'socket.io-client';
import { request } from './api';

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

interface CommunityConfig {
  enabled: boolean;
  api_url: string | null;
  identity?: { community_id: string } | null;
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
const [communityError, setCommunityError] = createSignal<string | null>(null);
const [publisherConnected, setPublisherConnected] = createSignal(false);

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
};

let socket: Socket | null = null;
let publisher: PeerHandle | null = null;
let listener: PeerHandle | null = null;
let listenerStatsTimer: number | undefined;
let playoutDelayMs = 120;
let programTimer: number | undefined;

interface PeerHandle {
  pc: RTCPeerConnection;
  resourceUrl?: string;
}

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

async function loadConfig(): Promise<CommunityConfig> {
  const current = config();
  if (current) return current;
  const loaded = await request<CommunityConfig>('/api/community/config');
  setConfig(loaded);
  return loaded;
}

async function publicRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const current = await loadConfig();
  if (!current.enabled || !current.api_url) throw new Error('community_disabled');
  const response = await fetch(`${current.api_url}${path}`, options);
  if (!response.ok) throw new Error(`community_${response.status}`);
  return response.json() as Promise<T>;
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
  socket.on('connect', () => setCommunityError(null));
}

export async function initCommunity(): Promise<void> {
  try {
    const current = await loadConfig();
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
  const response = await request<{ session: HostLiveSession }>('/api/community/sessions', {
    method: 'POST',
    body: { title },
    timeoutMs: 15000,
  });
  setHostSession(response.session);
  setProgram(null);
  setMessages([]);
  rememberHost(response.session.id);
  mergeSession(response.session);
  connectSocket(response.session, response.session);
  return response.session;
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

function closePeer(handle: PeerHandle | null): void {
  if (!handle) return;
  handle.pc.close();
  if (handle.resourceUrl) {
    void fetch(handle.resourceUrl, { method: 'DELETE' }).catch(() => {});
  }
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
  closePeer(publisher);
  publisher = null;
  setPublisherConnected(false);
  socket?.disconnect();
  socket = null;
  rememberHost(null);
  setHostSession(null);
  setProgram(null);
  setMessages([]);
}

export async function endHostSession(): Promise<void> {
  const session = hostSession();
  if (session) {
    await request<void>(`/api/community/sessions/${encodeURIComponent(session.id)}`, {
      method: 'DELETE',
      timeoutMs: 12000,
    }).catch(() => {});
  }
  await clearHostState();
}

function waitForIce(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const changed = () => {
      if (pc.iceGatheringState !== 'complete') return;
      pc.removeEventListener('icegatheringstatechange', changed);
      resolve();
    };
    pc.addEventListener('icegatheringstatechange', changed);
    window.setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', changed);
      resolve();
    }, 2500);
  });
}

function resourceLocation(endpoint: string, response: Response): string | undefined {
  const value = response.headers.get('Location');
  if (!value) return undefined;
  const endpointUrl = new URL(endpoint);
  if (value.startsWith('/') && endpointUrl.pathname.startsWith('/media/')) {
    return new URL(`/media${value}`, endpointUrl.origin).href;
  }
  return new URL(value, endpoint).href;
}

export async function startHostPublisher(stream: MediaStream): Promise<void> {
  const session = hostSession();
  if (!session || publisher) return;
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error('program_stream_missing');
  const pc = new RTCPeerConnection();
  const sender = pc.addTrack(track, stream);
  const parameters = sender.getParameters();
  if (parameters.encodings.length === 0) parameters.encodings = [{}];
  parameters.encodings[0].maxBitrate = 192_000;
  await sender.setParameters(parameters).catch(() => {});
  const offer = await pc.createOffer();
  await pc.setLocalDescription({ type: offer.type, sdp: musicOffer(offer.sdp) });
  await waitForIce(pc);
  const response = await fetch(session.whip_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sdp',
      Authorization: `Bearer ${session.publish_token}`,
    },
    body: pc.localDescription?.sdp,
  });
  if (!response.ok) {
    pc.close();
    throw new Error(`whip_${response.status}`);
  }
  await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
  publisher = { pc, resourceUrl: resourceLocation(session.whip_url, response) };
  pc.addEventListener('connectionstatechange', () => {
    const connected = pc.connectionState === 'connected';
    setPublisherConnected(connected);
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      publisher = null;
      setPublisherConnected(false);
    }
  });
  setPublisherConnected(pc.connectionState === 'connected');
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
  closePeer(listener);
  listener = null;
  socket?.disconnect();
  setJoinedSession(session);
  setProgram(session.program ?? null);
  setMessages([]);
  setListenerStream(null);
  connectSocket(session);
}

export async function startListening(): Promise<MediaStream> {
  const session = joinedSession();
  if (!session) throw new Error('session_missing');
  if (listenerStream()) return listenerStream()!;
  const pc = new RTCPeerConnection();
  pc.addTransceiver('audio', { direction: 'recvonly' });
  const incoming = new MediaStream();
  pc.addEventListener('track', (event) => {
    for (const track of event.streams[0]?.getTracks() ?? [event.track]) incoming.addTrack(track);
    setListenerStream(incoming);
  });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIce(pc);
  const response = await fetch(session.whep_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: pc.localDescription?.sdp,
  });
  if (!response.ok) {
    pc.close();
    throw new Error(`whep_${response.status}`);
  }
  await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
  listener = { pc, resourceUrl: resourceLocation(session.whep_url, response) };
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
  return incoming;
}

export async function leaveLiveSession(): Promise<void> {
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
}
