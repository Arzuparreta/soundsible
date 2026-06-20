import { toast } from './toast';

interface ShareableTrack {
  id: string;
  title: string;
  artist?: string;
  youtube_id?: string | null;
}

/**
 * Share a track via the Web Share API, falling back to clipboard. Ports the
 * legacy `shared.js` share flow: a YouTube URL when the track has one, else the
 * "Title — Artist" text. A user-cancelled native share is a no-op (not an error).
 */
export async function shareTrack(track: ShareableTrack): Promise<void> {
  const url = track.youtube_id ? `https://www.youtube.com/watch?v=${track.youtube_id}` : '';
  const text = track.artist ? `${track.title} — ${track.artist}` : track.title;

  if (navigator.share) {
    try {
      const data: ShareData = { title: track.title, text };
      if (url) data.url = url;
      await navigator.share(data);
      return;
    } catch (e) {
      // AbortError = user dismissed the share sheet; anything else falls through.
      if (e instanceof Error && e.name === 'AbortError') return;
    }
  }

  const payload = url || text;
  try {
    await navigator.clipboard.writeText(payload);
    toast.success('Copiado al portapapeles');
  } catch {
    toast.error('No se pudo compartir');
  }
}
