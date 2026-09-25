import { createMemo, Show } from 'solid-js';
import { useParams, useNavigate } from '@solidjs/router';
import { state, actions, musicLibrary } from '../stores';
import TrackList from '../components/TrackList';
import Button from '../components/Button';
import { BackIcon, MoreIcon, PlayIcon, QueueAddIcon } from '../components/icons';
import { useAppBar } from '../lib/appBar';
import { desktopShell } from '../lib/shellLayout';
import { openPlaylistMenu } from '../components/playlistActions';
import { trackCount } from '../lib/format';
import { t } from '../lib/i18n';
import type { Track } from '../types/music';
import styles from './PlaylistDetail.module.css';
import { EmptyState } from '../components/EmptyState';
import { navigateBackOr } from '../lib/scrollHistory';
import { playlistContext } from '../lib/playbackContext';

export default function PlaylistDetail() {
  const params = useParams();
  const navigate = useNavigate();
  // Solid Router exposes dynamic path segments in their URL-encoded form.
  // Playlist keys use the original display name, so decode the segment before
  // looking it up (e.g. "Road%20Trip" -> "Road Trip").
  const name = createMemo(() => decodeURIComponent(params.name ?? ''));
  const trackIds = createMemo<string[]>(() => state.playlists[name()] ?? []);
  const tracks = createMemo<Track[]>(() => {
    const byId = new Map(musicLibrary().map((t) => [t.id, t] as const));
    return trackIds()
      .map((id) => byId.get(id))
      .filter((t): t is Track => !!t);
  });

  const context = () => playlistContext(name(), tracks(), state.librarySettings);

  const playAll = () => {
    if (tracks().length > 0) {
      if (state.autoMode.active) {
        void actions.placeAutoTracks(tracks());
        return;
      }
      actions.playFrom(tracks(), 0, { context: context() });
    }
  };

  const openMenu = () =>
    openPlaylistMenu(name(), {
      onRenamed: (next) => navigate(`/playlists/${encodeURIComponent(next)}`, { replace: true }),
      onDeleted: () => navigate('/playlists', { replace: true }),
    });

  const back = () => navigateBackOr(navigate, '/playlists');
  useAppBar({
    title: name,
    back,
    backLabel: () => t('playlistDetail.ariaBack'),
    actions: () => [{ label: t('playlistDetail.ariaOptions'), icon: () => <MoreIcon />, opensDialog: true, onSelect: openMenu }],
  });

  return (
    <div class="view">
      <header class={styles.header}>
        <Show when={desktopShell()}>
          <button class={styles.back} type="button" aria-label={t('playlistDetail.ariaBack')} onClick={back}>
            <BackIcon size={20} />
          </button>
        </Show>
        <div class={styles.titleWrap}>
          <Show when={desktopShell()}>
            <h1 class={styles.title}>{name()}</h1>
          </Show>
          <span class={styles.count}>{trackCount(trackIds().length)}</span>
        </div>
        <Button onClick={playAll} disabled={tracks().length === 0}>
          {state.autoMode.active ? <QueueAddIcon size={16} /> : <PlayIcon size={16} />}
          {state.autoMode.active ? t('musicExplorer.requestAll') : t('playlistDetail.play')}
        </Button>
        <Show when={desktopShell()}>
          <button class={styles.menu} type="button" aria-label={t('playlistDetail.ariaOptions')} onClick={openMenu}>
            <MoreIcon size={20} />
          </button>
        </Show>
      </header>
      <TrackList
        tracks={tracks()}
        context={context()}
        loading={state.loading}
        menu={{
          playlistName: name(),
          onRemoveFromPlaylist: (t) => void actions.removeFromPlaylist(name(), t.id),
        }}
        empty={<EmptyState>{t('playlistDetail.empty')}</EmptyState>}
      />
    </div>
  );
}
