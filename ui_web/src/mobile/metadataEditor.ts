import { openTrackMetadataEditor } from '../components/metadataEditorView';
import { request } from '../lib/http';
import type { Track } from '../types/music';

/** Writes and refreshes stay tied to the account which opened the editor. */
export function openNativeMetadataEditor(track: Track, current: () => boolean, refresh: () => Promise<void>,
  findTrack: (id: string) => Track | undefined, updateProgram: (track: Track) => Promise<void>): void {
  if (!current() || track.source === 'preview') return;
  const controller = new AbortController();
  async function confirm(path: string, method: 'POST' | 'DELETE', body?: object | FormData) {
    if (!current()) throw new Error('Account changed');
    const reply = await request<{ status?: string; storage?: string; id?: string }>(path, { method, body, signal: controller.signal, timeoutMs: 30000 });
    if (!current()) return null;
    if (reply.status !== 'success' || reply.storage !== 'library' || reply.id !== track.id) throw new Error('Missing stable-source write confirmation');
    await refresh();
    if (!current()) return null;
    const saved = findTrack(track.id);
    if (!saved) throw new Error('Track removed');
    await updateProgram(saved);
    return current() ? saved : null;
  }
  const base = `/api/library/track-labels/${encodeURIComponent(track.id)}`;
  openTrackMetadataEditor(track, {
    current, dispose: () => controller.abort(),
    update: async values => {
      const saved = await confirm(`${base}/metadata`, 'POST', values);
      if (!saved) return false;
      if (saved.title !== values.title || saved.artist !== values.artist || (saved.album ?? '') !== values.album || (saved.album_artist ?? '') !== (values.album_artist ?? '')) throw new Error('Missing metadata confirmation');
      return true;
    },
    upload: async file => {
      const body = new FormData(); body.append('file', file);
      await confirm(`${base}/cover`, 'POST', body);
    },
    remove: async () => { await confirm(`${base}/cover/none`, 'POST'); },
  });
}
