import { createMemo } from 'solid-js';
import { useParams, useNavigate } from '@solidjs/router';
import { state, actions } from '../stores';
import TrackList from '../components/TrackList';
import Button from '../components/Button';
import { openPlaylistMenu } from '../components/playlistActions';
import { trackCount } from '../lib/format';
import type { Track } from '../types/music';
import styles from './PlaylistDetail.module.css';

export default function PlaylistDetail() {
  const params = useParams();
  const navigate = useNavigate();
  // Solid Router exposes dynamic path segments in their URL-encoded form.
  // Playlist keys use the original display name, so decode the segment before
  // looking it up (e.g. "Road%20Trip" -> "Road Trip").
  const name = createMemo(() => decodeURIComponent(params.name ?? ''));
  const trackIds = createMemo<string[]>(() => state.playlists[name()] ?? []);
  const tracks = createMemo<Track[]>(() => {
    const byId = new Map(state.library.map((t) => [t.id, t] as const));
    return trackIds()
      .map((id) => byId.get(id))
      .filter((t): t is Track => !!t);
  });

  const playAll = () => {
    if (tracks().length > 0) actions.playFrom(tracks(), 0);
  };

  const openMenu = () =>
    openPlaylistMenu(name(), {
      onRenamed: (next) => navigate(`/playlists/${encodeURIComponent(next)}`, { replace: true }),
      onDeleted: () => navigate('/playlists', { replace: true }),
    });

  return (
    <div class="view">
      <header class={styles.header}>
        <button class={styles.back} type="button" aria-label="Volver" onClick={() => navigate('/playlists')}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div class={styles.titleWrap}>
          <h1 class={styles.title}>{name()}</h1>
          <span class={styles.count}>{trackCount(tracks().length)}</span>
        </div>
        <Button onClick={playAll} disabled={tracks().length === 0}>
          Reproducir
        </Button>
        <button class={styles.menu} type="button" aria-label="Opciones de la lista" onClick={openMenu}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="19" cy="12" r="2" />
          </svg>
        </button>
      </header>
      <TrackList
        tracks={tracks()}
        loading={state.loading}
        menu={{
          playlistName: name(),
          onRemoveFromPlaylist: (t) => void actions.removeFromPlaylist(name(), t.id),
        }}
        empty={
          <p style={{ padding: '48px 16px', 'text-align': 'center', color: 'var(--ink-secondary)' }}>
            Lista vacía.
          </p>
        }
      />
    </div>
  );
}
