import { registerPlugin } from '@capacitor/core';
import { shareUrlForTrack } from '../lib/trackShare';
import type { Track } from '../types/music';
interface ShareBridge {
  open(options: { generation: number; title: string; text: string; url?: string }): Promise<{ opened: boolean }>;
}
const share = registerPlugin<ShareBridge>('SoundsibleShare');
/** The same public fragment capsule as web; local-only tracks and podcasts share plain metadata. */
export async function nativeShareTrack(track: Track, generation: () => number, current: () => boolean): Promise<boolean> {
  if (!current()) return false;
  const epoch = generation();
  const title = (track.title.trim() || track.id).slice(0, 512);
  const artist = track.artist?.trim().slice(0, 512);
  const text = artist ? `${title} — ${artist}` : title;
  const url = shareUrlForTrack(track);
  const result = await share.open({ generation: epoch, title, text, ...(url ? { url } : {}) });
  return current() && generation() === epoch && result.opened === true;
}
