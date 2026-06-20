import { createMemo, For, Show, type JSX } from 'solid-js';
import { useParams, useNavigate } from '@solidjs/router';
import { state, actions } from '../stores';
import TrackList from '../components/TrackList';
import Button from '../components/Button';
import { coverUrl } from '../lib/media';
import { buildAlbums } from '../lib/libraryView';
import type { Track } from '../types/music';
import styles from './Artist.module.css';

function gradientFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 50% 32%), hsl(${(h + 50) % 360} 55% 20%))`;
}

/** Artist detail: every library track by one artist, with play-all + shuffle.
 * Reached by tapping an artist name in a row or on the Now Playing screen. */
export default function Artist() {
  const params = useParams();
  const navigate = useNavigate();
  const name = createMemo(() => params.name ?? '');

  const tracks = createMemo<Track[]>(() => {
    const n = name().trim().toLowerCase();
    if (!n) return [];
    return state.library.filter(
      (t) => (t.artist ?? '').toLowerCase() === n || (t.album_artist ?? '').toLowerCase() === n,
    );
  });

  const albums = createMemo(() => buildAlbums(tracks()));
  const avatar = (): JSX.CSSProperties => ({ background: gradientFor(name()) });
  const albumBg = (id: string): JSX.CSSProperties => ({
    background: `url("${coverUrl(id)}") center / cover no-repeat, var(--bg-raised)`,
  });
  const playAll = () => tracks().length > 0 && actions.playFrom(tracks(), 0);
  const shuffle = () => actions.playShuffled(tracks());

  return (
    <div class="view">
      <header class={styles.header}>
        <button class={styles.back} type="button" aria-label="Volver" onClick={() => navigate(-1)}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>

        <div class={styles.hero}>
          <div class={styles.avatar} style={avatar()}>
            <span class={styles.initial}>{(name()[0] ?? '?').toUpperCase()}</span>
          </div>
          <h1 class={styles.title}>{name()}</h1>
          <span class={styles.count}>{tracks().length} pistas</span>
          <div class={styles.actions}>
            <Button onClick={playAll} disabled={tracks().length === 0}>
              Reproducir
            </Button>
            <Button variant="secondary" onClick={shuffle} disabled={tracks().length === 0}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style={{ 'margin-right': '6px' }}>
                <path d="M16 3h5v5M21 3l-7 7M4 20l7-7M16 21h5v-5M4 4l5 5" />
              </svg>
              Aleatorio
            </Button>
          </div>
        </div>
      </header>

      <Show when={albums().length > 1}>
        <div class={styles.albumRail}>
          <For each={albums()}>
            {(al) => (
              <button class={styles.albumCard} type="button" onClick={() => actions.playFrom(al.tracks, 0)}>
                <span class={styles.albumCover} style={albumBg(al.coverId)} />
                <span class={styles.albumName}>{al.name}</span>
                <span class={styles.albumCount}>{al.tracks.length} pistas</span>
              </button>
            )}
          </For>
        </div>
      </Show>

      <TrackList
        tracks={tracks()}
        loading={state.loading}
        empty={
          <p class={styles.empty}>No hay pistas de este artista en tu biblioteca.</p>
        }
      />
    </div>
  );
}
