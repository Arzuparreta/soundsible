import { describe, it, expect } from 'vitest';
import { buildTrackMenu } from './trackActions';
import type { Track } from '../types/music';

const labels = (track: Track, ctx = {}) => buildTrackMenu(track, ctx).map((a) => a.label);

const ctx = { onAddToPlaylist: () => {} };

describe('buildTrackMenu — podcast coherence', () => {
  const streamedEpisode: Track = {
    id: 'g1',
    title: 'Episode',
    artist: 'My Show',
    source: 'preview',
    media_kind: 'podcast_episode',
    podcast_episode_guid: 'g1',
  };

  it('streamed podcast episodes only expose share (no radio/queue/playlist/save/fav)', () => {
    const l = labels(streamedEpisode, ctx);
    expect(l).toContain('Compartir');
    expect(l).not.toContain('Iniciar radio');
    expect(l).not.toContain('Añadir a playlist');
    expect(l).not.toContain('Reproducir a continuación');
    expect(l).not.toContain('Añadir a la cola');
    expect(l).not.toContain('Guardar en biblioteca');
    expect(l).not.toContain('Añadir a favoritos');
  });

  it('downloaded podcast episodes can be queued but not put on radio/playlists', () => {
    const downloaded: Track = { id: 'd1', title: 'Episode', artist: 'My Show', media_kind: 'podcast_episode' };
    const l = labels(downloaded, ctx);
    expect(l).toContain('Reproducir a continuación');
    expect(l).toContain('Añadir a la cola');
    expect(l).not.toContain('Iniciar radio');
    expect(l).not.toContain('Añadir a playlist');
  });

  it('preview music tracks keep radio + save-to-library', () => {
    const preview: Track = { id: 'yt1', title: 'Song', artist: 'A', source: 'preview' };
    const l = labels(preview, ctx);
    expect(l).toContain('Iniciar radio');
    expect(l).toContain('Añadir a playlist');
    expect(l).toContain('Guardar en biblioteca');
  });
});
