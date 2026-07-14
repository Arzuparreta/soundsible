import { createMemo, createResource, createSignal, For, Show, type JSX, onCleanup } from 'solid-js';
import { useParams, useNavigate, useSearchParams } from '@solidjs/router';
import { state, actions, musicLibrary } from '../stores';
import { api } from '../lib/api';
import { coverUrl } from '../lib/media';
import { trackCount } from '../lib/format';
import { toast } from '../lib/toast';
import { artistKey, artistPath, albumPath, decodeArtistName, parseViewParams } from '../lib/artistRoute';
import { t } from '../lib/i18n';
import type { ArtistProfile, CatalogItem, Track } from '../types/music';
import styles from './Artist.module.css';

type ViewMode = 'discover' | 'library';

function gradientFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 50% 32%), hsl(${(h + 50) % 360} 55% 20%))`;
}

function formatFans(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
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

/** Artist detail page with discover/library toggle.
 * Reached by tapping an artist name, badge, or card anywhere in the app. */
export default function Artist() {
  const params = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const name = createMemo(() => decodeArtistName(params.name));
  const viewParams = createMemo(() => parseViewParams(searchParams as Record<string, string | undefined>));
  const [view, setView] = createSignal<ViewMode>(viewParams().view);
  const [disambigOpen, setDisambigOpen] = createSignal(false);
  const [saving, setSaving] = createSignal<Set<string>>(new Set());
  const [saved, setSaved] = createSignal<Set<string>>(new Set());

  let aborter: AbortController | undefined;

  const fetchProfile = async (artistName: string, deezerId?: string): Promise<ArtistProfile | null> => {
    aborter?.abort();
    aborter = new AbortController();
    try {
      return await api.getArtistProfile(artistName, deezerId, aborter.signal);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return null;
      throw e;
    }
  };

  const [profile] = createResource(
    () => ({ n: name(), id: viewParams().deezerId }),
    (args) => fetchProfile(args.n, args.id),
  );

  onCleanup(() => aborter?.abort());

  const libraryTrackList = createMemo<Track[]>(() => {
    const n = artistKey(name());
    if (!n) return [];
    return musicLibrary().filter(
      (t) => artistKey(t.artist) === n || artistKey(t.album_artist) === n,
    );
  });

  const topTracks = createMemo<CatalogItem[]>(() => profile()?.top_tracks ?? []);
  const albums = createMemo(() => profile()?.albums ?? []);
  const singlesEps = createMemo(() => profile()?.singles_eps ?? []);
  const related = createMemo(() => profile()?.related_artists ?? []);
  const candidates = createMemo(() => profile()?.candidates ?? []);
  const inLibrary = createMemo(() => profile()?.in_library ?? libraryTrackList().length > 0);

  const avatar = (): JSX.CSSProperties => {
    const pic = profile()?.metadata?.picture;
    if (pic) return { background: `url("${pic}") center / cover no-repeat` };
    return { background: gradientFor(name()) };
  };

  const showToggle = createMemo(() => inLibrary());

  const playAll = () => {
    if (view() === 'library') {
      const tracks = libraryTrackList();
      if (tracks.length > 0) actions.playFrom(tracks, 0);
    } else {
      const items = topTracks();
      if (items.length === 0) return;
      void playExternalItem(items[0], items);
    }
  };

  const shuffle = () => {
    if (view() === 'library') {
      actions.playShuffled(libraryTrackList());
    } else {
      const items = topTracks();
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
          if (tr) return tr;
          return { id: '', title: q.title, artist: itemArtist(q), cover: q.cover, source: 'preview' as const };
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

  const relatedBg = (picture: string, seed: string): JSX.CSSProperties => ({
    background: picture
      ? `url("${picture}") center / cover no-repeat`
      : gradientFor(seed),
  });

  const handleAlbumClick = (album: { deezer_id: string; title: string }) => {
    navigate(albumPath(album.title, name(), { deezerId: album.deezer_id, view: 'discover' }));
  };

  const handleRelatedClick = (artist: { deezer_id: string; name: string }) => {
    navigate(artistPath(artist.name, { deezerId: artist.deezer_id, view: 'discover' }));
  };

  const handleCandidateClick = (c: { deezer_id: string; name: string }) => {
    setDisambigOpen(false);
    navigate(artistPath(name(), { deezerId: c.deezer_id, view: 'discover' }));
  };

  const switchView = (mode: ViewMode) => {
    setView(mode);
  };

  return (
    <div class="view">
      <header class={styles.header}>
        <button class={styles.back} type="button" aria-label={t('artist.ariaBack')} onClick={() => navigate(-1)}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>

        <div class={styles.hero}>
          <div class={styles.avatar} style={avatar()}>
            <Show when={!profile()?.metadata?.picture}>
              <span class={styles.initial}>{(name()[0] ?? '?').toUpperCase()}</span>
            </Show>
          </div>
          <div class={styles.titleRow}>
            <h1 class={styles.title}>{name()}</h1>
            <Show when={candidates().length > 0}>
              <div class={styles.disambigWrap}>
                <button
                  class={styles.chevronBtn}
                  type="button"
                  aria-label={t('artist.notThisArtist')}
                  title={t('artist.notThisArtist')}
                  onClick={() => setDisambigOpen((v) => !v)}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
                <Show when={disambigOpen()}>
                  <div class={styles.disambigDropdown}>
                    <For each={candidates()}>
                      {(c) => (
                        <button class={styles.disambigItem} type="button" onClick={() => handleCandidateClick(c)}>
                          <span class={styles.disambigAvatar} style={relatedBg(c.picture, c.name)} />
                          <span class={styles.disambigMeta}>
                            <span class={styles.disambigName}>{c.name}</span>
                            <span class={styles.disambigFans}>{formatFans(c.nb_fans)} {t('artist.fans').replace('{n}', '').trim()}</span>
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
          <span class={styles.count}>
            <Show when={profile()?.metadata?.nb_fans}>
              {formatFans(profile()!.metadata!.nb_fans)} {t('artist.fans').replace('{n}', '').trim()}
            </Show>
            <Show when={profile()?.metadata?.nb_fans && inLibrary()}>
              {' · '}
            </Show>
            <Show when={inLibrary()}>
              {t('artist.inLibraryCount').replace('{n}', String(libraryTrackList().length))}
            </Show>
          </span>
          <div class={styles.actions}>
            <Button onClick={playAll} disabled={view() === 'library' ? libraryTrackList().length === 0 : topTracks().length === 0}>
              {t('artist.play')}
            </Button>
            <Button variant="secondary" onClick={shuffle} disabled={view() === 'library' ? libraryTrackList().length === 0 : topTracks().length === 0}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style={{ 'margin-right': '6px' }}>
                <path d="M16 3h5v5M21 3l-7 7M4 20l7-7M16 21h5v-5M4 4l5 5" />
              </svg>
              {t('artist.shuffle')}
            </Button>
          </div>
        </div>

        <Show when={showToggle()}>
          <div class={styles.toggleTabs}>
            <button
              classList={{ [styles.toggleTab]: true, [styles.toggleTabActive]: view() === 'discover' }}
              type="button"
              onClick={() => switchView('discover')}
            >
              {t('artist.discover')}
            </button>
            <button
              classList={{ [styles.toggleTab]: true, [styles.toggleTabActive]: view() === 'library' }}
              type="button"
              onClick={() => switchView('library')}
            >
              {t('artist.library')} ({libraryTrackList().length})
            </button>
          </div>
        </Show>
      </header>

      <Show
        when={profile.loading && !profile()}
        fallback={
          <Show
            when={profile()}
            fallback={<p class={styles.empty}>{t('artist.noCatalogData')}</p>}
          >
            <Show when={view() === 'discover'} fallback={<LibraryView tracks={libraryTrackList()} loading={false} />}>
              <DiscoverView
                topTracks={topTracks()}
                albums={albums()}
                singlesEps={singlesEps()}
                related={related()}
                loading={profile.loading}
                saving={saving()}
                saved={saved()}
                onPlayItem={playExternalItem}
                onSaveItem={saveItem}
                onAlbumClick={handleAlbumClick}
                onRelatedClick={handleRelatedClick}
              />
            </Show>
          </Show>
        }
      >
        <div class={styles.skeletonScroll}>
          <For each={Array.from({ length: 6 })}>{() => <div class={styles.skeletonRow} />}</For>
        </div>
      </Show>
    </div>
  );
}

function Button(props: { onClick: () => void; disabled?: boolean; variant?: 'primary' | 'secondary'; children: JSX.Element }) {
  return (
    <button
      classList={{
        [styles.btnPrimary]: props.variant !== 'secondary',
        [styles.btnSecondary]: props.variant === 'secondary',
      }}
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function LibraryView(props: { tracks: Track[]; loading: boolean }) {
  return (
    <div class={styles.libraryView}>
      <Show when={props.tracks.length > 0} fallback={<p class={styles.empty}>{t('artist.empty')}</p>}>
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
              <span class={styles.trackAlbum}>{track.album}</span>
            </span>
            <span class={styles.trackDuration}>{formatDuration(track.duration)}</span>
          </div>
        )}
      </For>
    </div>
  );
}

function formatDuration(seconds?: number): string {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function DiscoverView(props: {
  topTracks: CatalogItem[];
  albums: Array<{ deezer_id: string; title: string; cover: string; year?: number | null; track_count?: number }>;
  singlesEps: Array<{ deezer_id: string; title: string; cover: string; year?: number | null; track_count?: number }>;
  related: Array<{ deezer_id: string; name: string; picture: string; nb_fans: number }>;
  loading: boolean;
  saving: Set<string>;
  saved: Set<string>;
  onPlayItem: (item: CatalogItem, queue?: CatalogItem[]) => void;
  onSaveItem: (item: CatalogItem) => void;
  onAlbumClick: (album: { deezer_id: string; title: string }) => void;
  onRelatedClick: (artist: { deezer_id: string; name: string }) => void;
}) {
  return (
    <div class={styles.discoverView}>
      <Show when={props.topTracks.length > 0} fallback={<Show when={!props.loading}><p class={styles.sectionEmpty}>{t('artist.noTopTracks')}</p></Show>}>
        <section class={styles.section}>
          <h2 class={styles.sectionTitle}>{t('artist.topTracks')}</h2>
          <div class={styles.trackList}>
            <For each={props.topTracks.slice(0, 10)}>
              {(item, i) => (
                <div
                  classList={{ [styles.trackRow]: true, [styles.trackActive]: state.playback.currentTrack?.id === (item.track_id || item.id) }}
                  onClick={() => props.onPlayItem(item, props.topTracks.slice(0, 10))}
                >
                  <span class={styles.trackIndex}>{i() + 1}</span>
                  <span class={styles.trackCover} style={{ background: item.cover ? `url("${item.cover}") center / cover no-repeat, ${gradientFor(item.id)}` : gradientFor(item.id) }} />
                  <span class={styles.trackMeta}>
                    <span class={styles.trackTitle}>{item.title}</span>
                    <span class={styles.trackAlbum}>{item.album}</span>
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
        </section>
      </Show>

      <Show when={props.albums.length > 0} fallback={<Show when={!props.loading && props.topTracks.length > 0}><p class={styles.sectionEmpty}>{t('artist.noAlbums')}</p></Show>}>
        <section class={styles.section}>
          <h2 class={styles.sectionTitle}>{t('artist.albums')}</h2>
          <div class={styles.albumRail}>
            <For each={props.albums}>
              {(al) => (
                <button class={styles.albumCard} type="button" onClick={() => props.onAlbumClick(al)}>
                  <span class={styles.albumCover} style={{ background: al.cover ? `url("${al.cover}") center / cover no-repeat, ${gradientFor(al.title)}` : gradientFor(al.title) }} />
                  <span class={styles.albumName}>{al.title}</span>
                  <span class={styles.albumCount}>{al.year ? `${al.year}` : ''}{al.year && al.track_count ? ' · ' : ''}{al.track_count ? trackCount(al.track_count) : ''}</span>
                </button>
              )}
            </For>
          </div>
        </section>
      </Show>

      <Show when={props.singlesEps.length > 0}>
        <section class={styles.section}>
          <h2 class={styles.sectionTitle}>{t('artist.singlesEps')}</h2>
          <div class={styles.albumRail}>
            <For each={props.singlesEps}>
              {(al) => (
                <button class={styles.albumCard} type="button" onClick={() => props.onAlbumClick(al)}>
                  <span class={styles.albumCover} style={{ background: al.cover ? `url("${al.cover}") center / cover no-repeat, ${gradientFor(al.title)}` : gradientFor(al.title) }} />
                  <span class={styles.albumName}>{al.title}</span>
                  <span class={styles.albumCount}>{al.year ? `${al.year}` : ''}</span>
                </button>
              )}
            </For>
          </div>
        </section>
      </Show>

      <Show when={props.related.length > 0} fallback={<Show when={!props.loading && props.topTracks.length === 0 && props.albums.length === 0}><p class={styles.sectionEmpty}>{t('artist.noRelated')}</p></Show>}>
        <section class={styles.section}>
          <h2 class={styles.sectionTitle}>{t('artist.related')}</h2>
          <div class={styles.albumRail}>
            <For each={props.related}>
              {(artist) => (
                <button class={styles.albumCard} type="button" onClick={() => props.onRelatedClick(artist)}>
                  <span classList={{ [styles.albumCover]: true, [styles.roundCover]: true }} style={{ background: artist.picture ? `url("${artist.picture}") center / cover no-repeat, ${gradientFor(artist.name)}` : gradientFor(artist.name) }} />
                  <span class={styles.albumName}>{artist.name}</span>
                  <span class={styles.albumCount}>{formatFans(artist.nb_fans)} {t('artist.fans').replace('{n}', '').trim()}</span>
                </button>
              )}
            </For>
          </div>
        </section>
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
