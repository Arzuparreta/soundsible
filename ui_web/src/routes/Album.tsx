import { createMemo, createResource, createSignal, For, Show, type JSX, onCleanup } from 'solid-js';
import { useParams, useNavigate, useSearchParams } from '@solidjs/router';
import { state, actions, musicLibrary } from '../stores';
import { api } from '../lib/api';
import { coverUrl } from '../lib/media';
import { trackCount } from '../lib/format';
import { toast } from '../lib/toast';
import { artistKey, artistPath, decodeArtistName, parseViewParams } from '../lib/artistRoute';
import { t } from '../lib/i18n';
import type { AlbumProfile, CatalogItem, Track } from '../types/music';
import styles from './Album.module.css';

type ViewMode = 'discover' | 'library';

function gradientFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 50% 32%), hsl(${(h + 50) % 360} 55% 20%))`;
}

function itemArtist(item: CatalogItem): string {
  return item.artist || item.subtitle || '';
}

function itemToTrack(item: CatalogItem): Track | null {
  if (item.track_id) {
    const found = state.library.find((tr) => tr.id === item.track_id);
    if (found) return found;
  }
  if (item.raw?.id && typeof item.raw.id === 'string') {
    return {
      id: item.raw.id,
      title: String(item.raw.title || item.title),
      artist: String(item.raw.artist || itemArtist(item)),
      album: typeof item.raw.album === 'string' ? item.raw.album : item.album,
      duration: typeof item.raw.duration === 'number' ? item.raw.duration : item.duration,
      youtube_id: typeof item.raw.youtube_id === 'string' ? item.raw.youtube_id : undefined,
      cover: item.cover,
    };
  }
  return null;
}

function formatDuration(seconds?: number): string {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Album detail page with discover/library toggle.
 * Reached by tapping an album card from the artist page or search. */
export default function Album() {
  const params = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const title = createMemo(() => decodeArtistName(params.name));
  const viewParams = createMemo(() => parseViewParams(searchParams as Record<string, string | undefined>));
  const artistName = createMemo(() => (searchParams as Record<string, string | undefined>).artist || '');
  const [view, setView] = createSignal<ViewMode>(viewParams().view);
  const [saving, setSaving] = createSignal<Set<string>>(new Set());
  const [saved, setSaved] = createSignal<Set<string>>(new Set());

  let aborter: AbortController | undefined;

  const fetchAlbum = async (albumTitle: string, albumArtist: string, deezerId?: string): Promise<AlbumProfile | null> => {
    aborter?.abort();
    aborter = new AbortController();
    try {
      return await api.getAlbumProfile(albumTitle, albumArtist, deezerId, aborter.signal);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return null;
      throw e;
    }
  };

  const [profile] = createResource(
    () => ({ t: title(), a: artistName(), id: viewParams().deezerId }),
    (args) => fetchAlbum(args.t, args.a, args.id),
  );

  onCleanup(() => aborter?.abort());

  const libraryTrackList = createMemo<Track[]>(() => {
    const tKey = title().trim().toLowerCase();
    const aKey = artistKey(artistName());
    if (!tKey) return [];
    return musicLibrary().filter((t) => {
      const matchAlbum = (t.album || '').trim().toLowerCase() === tKey;
      const matchArtist = artistKey(t.artist) === aKey || artistKey(t.album_artist) === aKey;
      return matchAlbum && (aKey ? matchArtist : true);
    });
  });

  const tracklist = createMemo<CatalogItem[]>(() => profile()?.tracklist ?? []);
  const inLibrary = createMemo(() => profile()?.in_library ?? libraryTrackList().length > 0);
  const showToggle = createMemo(() => inLibrary());

  const coverStyle = (): JSX.CSSProperties => {
    const cover = profile()?.cover;
    if (cover) return { background: `url("${cover}") center / cover no-repeat` };
    return { background: gradientFor(title()) };
  };

  const playAll = () => {
    if (view() === 'library') {
      const tracks = libraryTrackList();
      if (tracks.length > 0) actions.playFrom(tracks, 0);
    } else {
      const items = tracklist();
      if (items.length === 0) return;
      void playExternalItem(items[0], items);
    }
  };

  const shuffle = () => {
    if (view() === 'library') {
      actions.playShuffled(libraryTrackList());
    } else {
      const items = tracklist();
      if (items.length === 0) return;
      const shuffled = [...items].sort(() => Math.random() - 0.5);
      void playExternalItem(shuffled[0], shuffled);
    }
  };

  const playExternalItem = async (item: CatalogItem, queue?: CatalogItem[]) => {
    const artist = itemArtist(item);
    if (!artist || !item.title) return;
    const existing = itemToTrack(item);
    if (existing) {
      if (queue) {
        const tracks = queue.map(itemToTrack).filter((tr): tr is Track => !!tr);
        if (tracks.length) actions.playFrom(tracks, 0);
      } else {
        actions.playTrack(existing);
      }
      return;
    }
    const h = toast.loading(t('artist.looking'));
    try {
      const resolved = await api.resolveCatalogItem({ artist, title: item.title, duration: item.duration });
      if (!resolved.video_id) throw new Error('not-found');
      const track: Track = {
        id: resolved.video_id,
        title: item.title,
        artist,
        album: item.album,
        duration: item.duration,
        cover: item.cover,
        source: 'preview',
      };
      if (queue) {
        const tracks = queue.map((q) => {
          const tr = itemToTrack(q);
          return tr ?? { id: '', title: q.title, artist: itemArtist(q), cover: q.cover, source: 'preview' as const };
        }).filter((tr) => tr.id);
        tracks[0] = track;
        actions.playFrom(tracks, 0);
      } else {
        actions.playTrack(track);
      }
      h.update('success', t('search.playingPreview'));
    } catch {
      h.update('error', t('search.noPreview'));
    }
  };

  const saveItem = async (item: CatalogItem) => {
    const artist = itemArtist(item);
    if (!artist || !item.title) return;
    setSaving((s) => new Set(s).add(item.id));
    try {
      const response = await api.saveCatalogItem({
        catalog_item_id: item.id,
        source: item.source,
        artist,
        title: item.title,
        duration: item.duration,
        cover: item.cover,
        external_ids: item.external_ids,
      });
      if (response.status === 'queued') {
        setSaved((s) => new Set(s).add(item.id));
        toast.success(t('search.addedToDownloads'));
      } else if (response.status === 'needs_review') {
        toast.info(t('search.chooseVersion'));
      } else {
        toast.error(t('search.notSaved'));
      }
    } catch {
      toast.error(t('search.notSaved'));
    } finally {
      setSaving((s) => {
        const next = new Set(s);
        next.delete(item.id);
        return next;
      });
    }
  };

  const goArtist = () => {
    const a = profile()?.artist || artistName();
    if (a) navigate(artistPath(a, { view: 'discover' }));
  };

  return (
    <div class="view">
      <header class={styles.header}>
        <button class={styles.back} type="button" aria-label={t('album.ariaBack')} onClick={() => navigate(-1)}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>

        <div class={styles.hero}>
          <div class={styles.cover} style={coverStyle()}>
            <Show when={!profile()?.cover}>
              <span class={styles.initial}>{(title()[0] ?? '?').toUpperCase()}</span>
            </Show>
          </div>
          <h1 class={styles.title}>{profile()?.title || title()}</h1>
          <button class={styles.artistLink} type="button" onClick={goArtist}>
            {profile()?.artist || artistName()}
          </button>
          <span class={styles.meta}>
            <Show when={profile()?.year}>{profile()!.year}</Show>
            <Show when={profile()?.year && tracklist().length > 0}> · </Show>
            <Show when={tracklist().length > 0}>{trackCount(tracklist().length)}</Show>
          </span>
          <div class={styles.actions}>
            <button class={styles.btnPrimary} type="button" disabled={view() === 'library' ? libraryTrackList().length === 0 : tracklist().length === 0} onClick={playAll}>
              {t('album.play')}
            </button>
            <button class={styles.btnSecondary} type="button" disabled={view() === 'library' ? libraryTrackList().length === 0 : tracklist().length === 0} onClick={shuffle}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style={{ 'margin-right': '6px' }}>
                <path d="M16 3h5v5M21 3l-7 7M4 20l7-7M16 21h5v-5M4 4l5 5" />
              </svg>
              {t('album.shuffle')}
            </button>
          </div>
        </div>

        <Show when={showToggle()}>
          <div class={styles.toggleTabs}>
            <button
              classList={{ [styles.toggleTab]: true, [styles.toggleTabActive]: view() === 'discover' }}
              type="button"
              onClick={() => setView('discover')}
            >
              {t('album.discover')}
            </button>
            <button
              classList={{ [styles.toggleTab]: true, [styles.toggleTabActive]: view() === 'library' }}
              type="button"
              onClick={() => setView('library')}
            >
              {t('album.library')} ({libraryTrackList().length})
            </button>
          </div>
        </Show>
      </header>

      <Show
        when={profile.loading && !profile()}
        fallback={
          <Show
            when={profile()}
            fallback={<p class={styles.empty}>{t('album.noTracklist')}</p>}
          >
            <Show when={view() === 'discover'} fallback={<LibraryView tracks={libraryTrackList()} />}>
              <DiscoverView
                tracklist={tracklist()}
                saving={saving()}
                saved={saved()}
                onPlayItem={playExternalItem}
                onSaveItem={saveItem}
              />
            </Show>
          </Show>
        }
      >
        <div class={styles.skeletonScroll}>
          <For each={Array.from({ length: 8 })}>{() => <div class={styles.skeletonRow} />}</For>
        </div>
      </Show>
    </div>
  );
}

function LibraryView(props: { tracks: Track[] }) {
  return (
    <div class={styles.contentView}>
      <Show when={props.tracks.length > 0} fallback={<p class={styles.empty}>{t('album.empty')}</p>}>
        <TrackListLite tracks={props.tracks} />
      </Show>
    </div>
  );
}

function TrackListLite(props: { tracks: Track[] }) {
  return (
    <div class={styles.trackList}>
      <For each={props.tracks}>
        {(track, i) => (
          <div
            classList={{ [styles.trackRow]: true, [styles.trackActive]: state.playback.currentTrack?.id === track.id }}
            onClick={() => actions.playFrom(props.tracks, i())}
          >
            <span class={styles.trackIndex}>{i() + 1}</span>
            <span class={styles.trackCover} style={{ background: `url("${coverUrl(track.id)}") center / cover no-repeat, ${gradientFor(track.id)}` }} />
            <span class={styles.trackMeta}>
              <span class={styles.trackTitle}>{track.title}</span>
            </span>
            <span class={styles.trackDuration}>{formatDuration(track.duration)}</span>
          </div>
        )}
      </For>
    </div>
  );
}

function DiscoverView(props: {
  tracklist: CatalogItem[];
  saving: Set<string>;
  saved: Set<string>;
  onPlayItem: (item: CatalogItem, queue?: CatalogItem[]) => void;
  onSaveItem: (item: CatalogItem) => void;
}) {
  return (
    <div class={styles.contentView}>
      <Show when={props.tracklist.length > 0} fallback={<p class={styles.empty}>{t('album.noTracklist')}</p>}>
        <div class={styles.trackList}>
          <For each={props.tracklist}>
            {(item, i) => (
              <div
                classList={{ [styles.trackRow]: true, [styles.trackActive]: state.playback.currentTrack?.id === (item.track_id || item.id) }}
                onClick={() => props.onPlayItem(item, props.tracklist)}
              >
                <span class={styles.trackIndex}>{i() + 1}</span>
                <span class={styles.trackCover} style={{ background: item.cover ? `url("${item.cover}") center / cover no-repeat, ${gradientFor(item.id)}` : gradientFor(item.id) }} />
                <span class={styles.trackMeta}>
                  <span class={styles.trackTitle}>{item.title}</span>
                  <Show when={item.artist && item.artist !== (item.subtitle || '')}>
                    <span class={styles.trackArtist}>{itemArtist(item)}</span>
                  </Show>
                </span>
                <span class={styles.trackDuration}>{formatDuration(item.duration)}</span>
                <Show when={item.action_state?.in_library || props.saved.has(item.id)}>
                  <span class={styles.libraryBadge} aria-label={t('search.ariaInLibrary')}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5">
                      <path d="M5 12l5 5L20 7" />
                    </svg>
                  </span>
                </Show>
                <Show when={item.type === 'track' && !item.action_state?.in_library && !props.saved.has(item.id)}>
                  <button
                    class={styles.iconBtn}
                    type="button"
                    disabled={props.saving.has(item.id)}
                    aria-label={t('search.ariaSave')}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onSaveItem(item);
                    }}
                  >
                    <Show when={props.saving.has(item.id)} fallback={<PlusIcon />}>
                      <span class={styles.smallSpinner} />
                    </Show>
                  </button>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
