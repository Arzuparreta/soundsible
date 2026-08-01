export interface CommunityPeerHandle {
  pc: RTCPeerConnection;
  resourceUrl?: string;
  close: () => void;
}

interface BasePeerOptions {
  endpoint: string;
  token?: string;
  iceTransportPolicy?: RTCIceTransportPolicy;
  onTrack?: (event: RTCTrackEvent) => void;
  onTransportError?: (error: Error) => void;
}

interface PublisherOptions extends BasePeerOptions {
  stream: MediaStream;
  transformOffer?: (sdp: string | undefined) => string | undefined;
}

interface ListenerOptions extends BasePeerOptions {}

interface OfferData {
  iceUfrag: string;
  icePwd: string;
  medias: string[];
}

function unquote(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

/** Parse RFC 9725 Link values without letting one malformed entry discard the
 * usable ICE servers that follow it. */
export function parseIceServerLinks(value: string | null): RTCIceServer[] {
  if (!value) return [];
  const servers: RTCIceServer[] = [];
  for (const entry of value.split(/,\s*(?=<)/)) {
    const target = /^\s*<([^>]+)>/.exec(entry)?.[1];
    if (!target || !/^(?:stun|stuns|turn|turns):/i.test(target)) continue;
    const params = new Map<string, string>();
    const pattern = /;\s*([\w-]+)\s*=\s*(?:"((?:\\.|[^"])*)"|([^;,\s]+))/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(entry)) !== null) {
      params.set(match[1].toLowerCase(), match[2] === undefined ? match[3] : unquote(match[2]));
    }
    if (!(params.get('rel') ?? '').split(/\s+/).includes('ice-server')) continue;
    const server: RTCIceServer = { urls: [target] };
    const username = params.get('username');
    const credential = params.get('credential');
    if (username !== undefined && credential !== undefined) {
      server.username = username;
      server.credential = credential;
    }
    servers.push(server);
  }
  return servers;
}

function parseOffer(sdp: string): OfferData {
  const data: OfferData = { iceUfrag: '', icePwd: '', medias: [] };
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('m=')) data.medias.push(line.slice(2));
    else if (!data.iceUfrag && line.startsWith('a=ice-ufrag:')) data.iceUfrag = line.slice(12);
    else if (!data.icePwd && line.startsWith('a=ice-pwd:')) data.icePwd = line.slice(10);
  }
  if (!data.iceUfrag || !data.icePwd || data.medias.length === 0) {
    throw new Error('webrtc_offer_missing_ice');
  }
  return data;
}

export function generateIceFragment(data: OfferData, candidates: RTCIceCandidate[]): string {
  const byMedia = new Map<number, RTCIceCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.sdpMLineIndex === null) continue;
    const current = byMedia.get(candidate.sdpMLineIndex) ?? [];
    current.push(candidate);
    byMedia.set(candidate.sdpMLineIndex, current);
  }
  let fragment = `a=ice-ufrag:${data.iceUfrag}\r\na=ice-pwd:${data.icePwd}\r\n`;
  data.medias.forEach((media, index) => {
    const current = byMedia.get(index);
    if (!current?.length) return;
    fragment += `m=${media}\r\na=mid:${index}\r\n`;
    for (const candidate of current) fragment += `a=${candidate.candidate}\r\n`;
  });
  return fragment;
}

export function communityResourceLocation(endpoint: string, response: Response): string | undefined {
  const value = response.headers.get('Location');
  if (!value) return undefined;
  const endpointUrl = new URL(endpoint);
  if (value.startsWith('/') && endpointUrl.pathname.startsWith('/media/')) {
    return new URL(`/media${value}`, endpointUrl.origin).href;
  }
  return new URL(value, endpoint).href;
}

function authHeaders(token?: string): HeadersInit {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function discoverIceServers(endpoint: string, token?: string): Promise<RTCIceServer[]> {
  const response = await fetch(endpoint, { method: 'OPTIONS', headers: authHeaders(token) });
  if (!response.ok) throw new Error(`ice_servers_${response.status}`);
  return parseIceServerLinks(response.headers.get('Link'));
}

async function openPeer(
  options: BasePeerOptions,
  configure: (pc: RTCPeerConnection) => void,
  transformOffer?: (sdp: string | undefined) => string | undefined,
): Promise<CommunityPeerHandle> {
  const iceServers = await discoverIceServers(options.endpoint, options.token);
  const pc = new RTCPeerConnection({
    iceServers,
    iceTransportPolicy: options.iceTransportPolicy ?? 'all',
  });
  let resourceUrl: string | undefined;
  let offerData: OfferData | undefined;
  let queuedCandidates: RTCIceCandidate[] = [];
  let closed = false;

  const reportTransportError = (error: unknown) => {
    if (closed) return;
    options.onTransportError?.(error instanceof Error ? error : new Error(String(error)));
  };
  const sendCandidates = async (candidates: RTCIceCandidate[]) => {
    if (!resourceUrl || !offerData || closed || candidates.length === 0) return;
    const response = await fetch(resourceUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/trickle-ice-sdpfrag',
        'If-Match': '*',
      },
      body: generateIceFragment(offerData, candidates),
    });
    if (response.status !== 204) throw new Error(`ice_patch_${response.status}`);
  };

  try {
    pc.addEventListener('icecandidate', (event) => {
      if (!event.candidate || closed) return;
      if (!resourceUrl) queuedCandidates.push(event.candidate);
      else void sendCandidates([event.candidate]).catch(reportTransportError);
    });
    if (options.onTrack) pc.addEventListener('track', options.onTrack);
    configure(pc);
    const offer = await pc.createOffer();
    const offerSdp = transformOffer ? transformOffer(offer.sdp) : offer.sdp;
    if (!offerSdp) throw new Error('webrtc_offer_missing_sdp');
    offerData = parseOffer(offerSdp);
    await pc.setLocalDescription({ type: 'offer', sdp: offerSdp });
    const response = await fetch(options.endpoint, {
      method: 'POST',
      headers: {
        ...authHeaders(options.token),
        'Content-Type': 'application/sdp',
      },
      body: offerSdp,
    });
    if (response.status !== 201) throw new Error(`webrtc_offer_${response.status}`);
    resourceUrl = communityResourceLocation(options.endpoint, response);
    if (!resourceUrl) throw new Error('webrtc_resource_missing');
    await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    const pending = queuedCandidates;
    queuedCandidates = [];
    await sendCandidates(pending);
  } catch (error) {
    closed = true;
    pc.close();
    if (resourceUrl) void fetch(resourceUrl, { method: 'DELETE' }).catch(() => {});
    throw error;
  }

  return {
    pc,
    resourceUrl,
    close: () => {
      if (closed) return;
      closed = true;
      pc.close();
      if (resourceUrl) void fetch(resourceUrl, { method: 'DELETE' }).catch(() => {});
    },
  };
}

export function openCommunityPublisher(options: PublisherOptions): Promise<CommunityPeerHandle> {
  return openPeer(options, (pc) => {
    const track = options.stream.getAudioTracks()[0];
    if (!track) throw new Error('program_stream_missing');
    const sender = pc.addTrack(track, options.stream);
    const parameters = sender.getParameters();
    if (parameters.encodings.length === 0) parameters.encodings = [{}];
    parameters.encodings[0].maxBitrate = 192_000;
    void sender.setParameters(parameters).catch(() => {});
  }, options.transformOffer);
}

export function openCommunityListener(options: ListenerOptions): Promise<CommunityPeerHandle> {
  return openPeer(options, (pc) => {
    pc.addTransceiver('audio', { direction: 'recvonly' });
  });
}
