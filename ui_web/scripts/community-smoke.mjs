import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { chromium } from '@playwright/test';

const apiUrl = (process.env.COMMUNITY_SMOKE_API || 'http://127.0.0.1:18080').replace(/\/$/, '');

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

const browser = await chromium.launch({ headless: true });
let published;
let received;
try {
  const publisherPage = await browser.newPage();
  await publisherPage.goto(`${apiUrl}/health`);
  published = await publisherPage.evaluate(async ({ endpoint, token }) => {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const destination = context.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();

    const pc = new RTCPeerConnection();
    pc.addTrack(destination.stream.getAudioTracks()[0], destination.stream);
    await pc.setLocalDescription(await pc.createOffer());
    if (pc.iceGatheringState !== 'complete') {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') {
            clearTimeout(timer);
            resolve();
          }
        });
      });
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp', Authorization: `Bearer ${token}` },
      body: pc.localDescription.sdp,
    });
    if (!response.ok) throw new Error(`WHIP ${response.status}: ${await response.text()}`);
    await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    globalThis.__communitySmoke = { context, oscillator, pc };
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
    return { state: pc.connectionState, resource: response.headers.get('Location') };
  }, { endpoint: session.whip_url, token: session.publish_token });

  const listenerPage = await browser.newPage();
  await listenerPage.goto(`${apiUrl}/health`);
  received = await listenerPage.evaluate(async (endpoint) => {
    const pc = new RTCPeerConnection();
    pc.addTransceiver('audio', { direction: 'recvonly' });
    let track;
    pc.addEventListener('track', (event) => { track = event.track; });
    await pc.setLocalDescription(await pc.createOffer());
    if (pc.iceGatheringState !== 'complete') {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') {
            clearTimeout(timer);
            resolve();
          }
        });
      });
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp,
    });
    if (!response.ok) throw new Error(`WHEP ${response.status}: ${await response.text()}`);
    await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
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
    globalThis.__communitySmoke = { pc };
    return {
      state: pc.connectionState,
      track: track.readyState,
      bytesReceived: inbound.bytesReceived,
      resource: response.headers.get('Location'),
    };
  }, session.whep_url);
} finally {
  await browser.close();
  await signedRequest('DELETE', `/v1/sessions/${session.id}`, { profile }).catch(() => {});
}

if (published?.state !== 'connected' || received?.state !== 'connected' || received.bytesReceived <= 0) {
  throw new Error(`unexpected WebRTC result: ${JSON.stringify({ published, received })}`);
}
console.log(JSON.stringify({ published: published.state, received: received.state, bytesReceived: received.bytesReceived }));
