import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from '@playwright/test';
import { build } from 'vite';

const requestedBrowsers = (process.env.COMMUNITY_SMOKE_BROWSERS || process.env.COMMUNITY_SMOKE_BROWSER || 'chromium')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
if (requestedBrowsers.length > 1 && process.env.COMMUNITY_SMOKE_CHILD !== '1') {
  for (const browserName of requestedBrowsers) {
    execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: {
        ...process.env,
        COMMUNITY_SMOKE_BROWSERS: browserName,
        COMMUNITY_SMOKE_BROWSER: browserName,
        COMMUNITY_SMOKE_CHILD: '1',
      },
      stdio: 'inherit',
    });
  }
  process.exit(0);
}
const browserName = requestedBrowsers[0];
const browserType = { chromium, firefox }[browserName];
if (!browserType) throw new Error(`unsupported smoke browser: ${browserName}`);
const forceRelay = process.env.COMMUNITY_SMOKE_FORCE_RELAY === '1';

const apiUrl = (process.env.COMMUNITY_SMOKE_API || 'http://127.0.0.1:18080').replace(/\/$/, '');
const socketClientPath = fileURLToPath(
  new URL('../node_modules/socket.io-client/dist/socket.io.min.js', import.meta.url),
);
const harnessDir = await mkdtemp(join(tmpdir(), 'soundsible-community-smoke-'));
await build({
  configFile: false,
  logLevel: 'silent',
  build: {
    lib: {
      entry: fileURLToPath(new URL('../src/lib/communityWebrtc.ts', import.meta.url)),
      name: 'SoundsibleCommunityWebrtc',
      formats: ['iife'],
      fileName: () => 'community-webrtc.js',
    },
    outDir: harnessDir,
    emptyOutDir: true,
    minify: false,
  },
});
const communityWebrtcScript = await readFile(join(harnessDir, 'community-webrtc.js'), 'utf8');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicRaw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
const communityId = createHash('sha256').update(publicRaw).digest().subarray(0, 18).toString('base64url');

function stationHeaders(method, path, body) {
  const encoded = canonical(body);
  const timestamp = `${Math.floor(Date.now() / 1000)}`;
  const nonce = randomBytes(18).toString('base64url');
  const digest = createHash('sha256').update(encoded).digest('hex');
  const message = `${timestamp}\n${nonce}\n${method}\n${path}\n${digest}`;
  return {
    encoded,
    headers: {
      'Content-Type': 'application/json',
      'X-Soundsible-Community-Id': communityId,
      'X-Soundsible-Public-Key': publicRaw.toString('base64url'),
      'X-Soundsible-Signature': sign(null, Buffer.from(message), privateKey).toString('base64url'),
      'X-Soundsible-Timestamp': timestamp,
      'X-Soundsible-Nonce': nonce,
    },
  };
}

async function signedRequest(method, path, body) {
  const { encoded, headers } = stationHeaders(method, path, body);
  return fetch(`${apiUrl}${path}`, { method, headers, body: encoded });
}

const profile = { display_name: 'Community smoke', avatar_color: '#f2763d' };
const created = await signedRequest('POST', '/v1/sessions', { title: 'WebRTC smoke', profile });
if (!created.ok) throw new Error(`create session failed: ${created.status} ${await created.text()}`);
const { session } = await created.json();

let browser;
let published;
let received;
let metadata;
let chat;
let ended;
try {
  browser = await browserType.launch({ headless: true });
  const publisherPage = await browser.newPage();
  await publisherPage.goto(`${apiUrl}/health`);
  await publisherPage.addScriptTag({ path: socketClientPath });
  await publisherPage.addScriptTag({ content: communityWebrtcScript });
  await publisherPage.evaluate(({ sessionId, hostToken }) => new Promise((resolve, reject) => {
    const socket = globalThis.io(location.origin, {
      transports: ['websocket', 'polling'],
      auth: { session_id: sessionId, host_token: hostToken },
    });
    globalThis.__communityHostSocket = socket;
    const timer = setTimeout(() => reject(new Error('host socket timeout')), 8000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', reject);
  }), { sessionId: session.id, hostToken: session.host_token });
  published = await publisherPage.evaluate(async ({ endpoint, token, relayOnly }) => {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const destination = context.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();
    const handle = await globalThis.SoundsibleCommunityWebrtc.openCommunityPublisher({
      endpoint,
      token,
      stream: destination.stream,
      iceTransportPolicy: relayOnly ? 'relay' : 'all',
    });
    const pc = handle.pc;
    globalThis.__communitySmoke = { context, oscillator, handle, pc };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`publisher state ${pc.connectionState}`)), 12000);
      const check = () => {
        if (pc.connectionState === 'connected') {
          clearTimeout(timer);
          resolve();
        }
      };
      pc.addEventListener('connectionstatechange', check);
      check();
    });
    return { state: pc.connectionState, resource: handle.resourceUrl };
  }, { endpoint: session.whip_url, token: session.publish_token, relayOnly: forceRelay });

  const listenerPage = await browser.newPage();
  await listenerPage.goto(`${apiUrl}/health`);
  await listenerPage.addScriptTag({ path: socketClientPath });
  await listenerPage.addScriptTag({ content: communityWebrtcScript });
  await listenerPage.evaluate((sessionId) => new Promise((resolve, reject) => {
    const socket = globalThis.io(location.origin, {
      transports: ['websocket', 'polling'],
      auth: {
        session_id: sessionId,
        guest_id: 'guest-community-smoke',
        guest_name: 'Smoke listener',
      },
    });
    globalThis.__communityListenerSocket = socket;
    const timer = setTimeout(() => reject(new Error('listener socket timeout')), 8000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', reject);
  }), session.id);
  received = await listenerPage.evaluate(async ({ endpoint, relayOnly }) => {
    let track;
    const handle = await globalThis.SoundsibleCommunityWebrtc.openCommunityListener({
      endpoint,
      iceTransportPolicy: relayOnly ? 'relay' : 'all',
      onTrack: (event) => { track = event.track; },
    });
    const pc = handle.pc;
    await new Promise((resolve, reject) => {
      const started = Date.now();
      const check = async () => {
        const stats = await pc.getStats();
        const inbound = [...stats.values()].find((item) => item.type === 'inbound-rtp' && item.kind === 'audio');
        if (track?.readyState === 'live' && inbound?.bytesReceived > 0) return resolve();
        if (Date.now() - started > 12000) return reject(new Error(`listener state ${pc.connectionState}`));
        setTimeout(check, 150);
      };
      void check();
    });
    const stats = await pc.getStats();
    const inbound = [...stats.values()].find((item) => item.type === 'inbound-rtp' && item.kind === 'audio');
    globalThis.__communitySmoke = { handle, pc };
    return {
      state: pc.connectionState,
      track: track.readyState,
      bytesReceived: inbound.bytesReceived,
      resource: handle.resourceUrl,
    };
  }, { endpoint: session.whep_url, relayOnly: forceRelay });

  // Emit after the listener is ready; keep exact metadata free of library ids.
  const programEvent = {
    v: 1,
    seq: 1,
    emitted_at: Date.now(),
    program_time: 3.5,
    transport: 'playing',
    primary: {
      id: 'public-smoke-track',
      title: 'Community smoke tone',
      artist: 'Soundsible',
      artwork_url: null,
      position: 3.5,
      duration: 30,
      gain: 1,
    },
    secondary: null,
    transition: null,
  };
  const metadataPromise = listenerPage.evaluate(() => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('program metadata timeout')), 8000);
    globalThis.__communityListenerSocket.once('program_event', (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  }));
  await publisherPage.evaluate((payload) => {
    globalThis.__communityHostSocket.emit('program_event', payload);
  }, programEvent);
  metadata = await metadataPromise;

  const chatPromise = publisherPage.evaluate(() => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('chat timeout')), 8000);
    globalThis.__communityHostSocket.once('chat_message', (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  }));
  await listenerPage.evaluate(() => {
    globalThis.__communityListenerSocket.emit('chat_message', { text: 'smoke request' });
  });
  chat = await chatPromise;

  const endedPromise = listenerPage.evaluate(() => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('session end timeout')), 8000);
    globalThis.__communityListenerSocket.once('session_ended', (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  }));
  const deleted = await signedRequest('DELETE', `/v1/sessions/${session.id}`, { profile });
  if (!deleted.ok) throw new Error(`delete session failed: ${deleted.status} ${await deleted.text()}`);
  ended = await endedPromise;
} finally {
  await browser?.close();
  await signedRequest('DELETE', `/v1/sessions/${session.id}`, { profile }).catch(() => {});
  await rm(harnessDir, { recursive: true, force: true });
}

const listing = await fetch(`${apiUrl}/v1/sessions`).then((response) => response.json());
if (
  published?.state !== 'connected'
  || received?.state !== 'connected'
  || received.bytesReceived <= 0
  || metadata?.primary?.title !== 'Community smoke tone'
  || chat?.text !== 'smoke request'
  || ended?.session_id !== session.id
  || listing.sessions.some((item) => item.id === session.id)
) {
  throw new Error(`unexpected Community result: ${JSON.stringify({
    published,
    received,
    metadata,
    chat,
    ended,
    remaining: listing.sessions,
  })}`);
}
console.log(JSON.stringify({
  browser: browserName,
  relayOnly: forceRelay,
  published: published.state,
  received: received.state,
  bytesReceived: received.bytesReceived,
  metadata: metadata.primary.title,
  chat: chat.text,
  ended: ended.session_id,
  removed: true,
}));
