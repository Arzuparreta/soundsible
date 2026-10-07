import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { shareUrlForTrack } from '../lib/trackShare';
import { liveRoomLink } from '../lib/liveLinks';
import type { Track } from '../types/music';
export interface IncomingTrackEnvelope { token: string; url: string }
interface ShareBridge {
  incoming(): Promise<{ incoming: IncomingTrackEnvelope | null }>;
  dismiss(options: { token: string }): Promise<{ dismissed: boolean }>;
  addListener(event: 'incomingTrack', listener: (value: IncomingTrackEnvelope) => void): Promise<PluginListenerHandle>;
  open(options: { generation: number; title: string; text: string; url?: string }): Promise<{ opened: boolean }>;
}
export const nativeShare = registerPlugin<ShareBridge>('SoundsibleShare');
/** The same public fragment capsule as web; local-only tracks and podcasts share plain metadata. */
export async function nativeShareTrack(track: Track, generation: () => number, current: () => boolean): Promise<boolean> {
  if (!current()) return false;
  const epoch = generation();
  const title = (track.title.trim() || track.id).slice(0, 512);
  const artist = track.artist?.trim().slice(0, 512);
  const text = artist ? `${title} — ${artist}` : title;
  const url = shareUrlForTrack(track);
  const result = await nativeShare.open({ generation: epoch, title, text, ...(url ? { url } : {}) });
  return current() && generation() === epoch && result.opened === true;
}

/** Share the public listener hub; private host/relay endpoints never enter the chooser. */
export async function nativeShareLive(session: { id: string; title: string }, generation: () => number, current: () => boolean): Promise<boolean> {
  if (!current() || !/^[A-Za-z0-9_-]{12,64}$/.test(session.id)) return false;
  const epoch = generation(), title = session.title.trim().slice(0, 512);
  if (!title) return false;
  const result = await nativeShare.open({ generation: epoch, title, text: title, url: liveRoomLink(session.id) });
  return current() && generation() === epoch && result.opened === true;
}
