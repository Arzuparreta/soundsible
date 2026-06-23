import { createMemo, createSignal, For, Match, Show, Switch, onCleanup, onMount, type JSX } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { api, type DiscoveryFeedItem, type DiscoveryFeedSection, type DiscoverySaveCandidate } from '../lib/api';
import { actions, state } from '../stores';
import { coverUrl } from '../lib/media';
import { ensureDiscover, feedItems, feedSections, refreshDiscover, revalidating } from '../lib/discover';
import { openTrackMenu, trackMenuOptions } from '../components/trackActions';
import { openPlaylistPicker } from '../components/PlaylistPicker';
import { openMetadataEditor } from '../components/MetadataEditor';
import { attachContextMenu, type MenuProvider } from '../lib/contextMenu';
import SearchResultRow from '../components/SearchResultRow';
import { toast } from '../lib/toast';
import type { SearchResult, Track } from '../types/music';
import styles from './Discover.module.css';

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

function itemKey(item: DiscoveryFeedItem): string {
  return item.id || item.track_id || `${item.artist}:${item.title}`;
}

function itemCover(item: DiscoveryFeedItem): string | undefined {
  if (item.action_state?.in_library && item.track_id) return coverUrl(item.track_id);
  return item.cover;
}

function isExternal(item: DiscoveryFeedItem): boolean {
  return !!item.deezer_id || !!item.action_state?.needs_resolution || item.source?.startsWith('deezer') === true;
}

function candidateId(candidate: DiscoverySaveCandidate): string {
  return candidate.video_id || candidate.id || '';
}

/**
 * Discover: real music feed backed by the engine's discovery contract.
 * Local-library rails play instantly; external rows use Deezer metadata for
 * discovery and resolve through Soundsible/YouTube only when previewed or saved.
 */
export default function Discover() {
  const navigate = useNavigate();
  const [q, setQ] = createSignal('');
  const [results, setResults] = createSignal<SearchResult[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [searchError, setSearchError] = createSignal(false);
  const [enqueued, setEnqueued] = createSignal<Set<string>>(new Set());
  const [resolved, setResolved] = createSignal<Map<string, SearchResult>>(new Map());
  const [saving, setSaving] = createSignal<Set<string>>(new Set());
  const [review, setReview] = createSignal<{ item: DiscoveryFeedItem; candidates: DiscoverySaveCandidate[] } | null>(null);

  const libYt = createMemo(() => new Set(state.library.map((t) => t.youtube_id).filter((x): x is string => !!x)));
  const libById = createMemo(() => new Map(state.library.map((t) => [t.id, t] as const)));
  const itemById = createMemo(() => new Map(feedItems().map((it) => [it.id, it] as const)));
  const browsing = () => !q().trim();

  const searchCache = new Map<string, SearchResult[]>();
  let aborter: AbortController | undefined;
  let debounce: number | undefined;
  let requestId = 0;
  let searchInput: HTMLInputElement | undefined;

  onMount(() => ensureDiscover());

  const run = (query: string) => {
    query = query.trim();
    const currentRequest = ++requestId;
    aborter?.abort();
    aborter = undefined;
    setSearchError(false);
    if (query.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    const cached = searchCache.get(query);
    if (cached) {
      setResults(cached);
      setLoading(false);
      return;
    }
    aborter = new AbortController();
    setLoading(true);
    api
      .searchYouTube(query, aborter.signal)
      .then((res) => {
        if (currentRequest !== requestId) return;
        searchCache.set(query, res);
        setResults(res);
      })
      .catch((e) => {
        if (currentRequest !== requestId || isAbort(e)) return;
        setResults([]);
        setSearchError(true);
      })
      .finally(() => {
        if (currentRequest === requestId) setLoading(false);
      });
  };

  const onInput = (v: string) => {
    setQ(v);
    clearTimeout(debounce);
    debounce = window.setTimeout(() => run(v), 180);
  };

  const toTrack = (item: DiscoveryFeedItem): Track | null => {
    if (!item.track_id) return null;
    return (
      libById().get(item.track_id) ?? {
        id: item.track_id,
        title: item.title,
        artist: item.artist,
        album: item.album,
        duration: item.duration,
        cover: item.cover,
      }
    );
  };

  const trackCtx = () => ({ navigate, onAddToPlaylist: openPlaylistPicker, onEditMetadata: openMetadataEditor });
  const menuOptsFor = (item: DiscoveryFeedItem) => {
    const track = toTrack(item);
    return track ? trackMenuOptions(track, trackCtx()) : null;
  };
  const menuFor = (item: DiscoveryFeedItem, ev?: MouseEvent) => {
    const track = toTrack(item);
    if (track) openTrackMenu(track, trackCtx(), ev);
  };

  const sectionItems = (section: DiscoveryFeedSection): DiscoveryFeedItem[] =>
    (section.item_ids ?? []).map((id) => itemById().get(id)).filter((x): x is DiscoveryFeedItem => !!x);

  const playLocalSection = (section: DiscoveryFeedSection, item: DiscoveryFeedItem) => {
    const tracks = sectionItems(section).map(toTrack).filter((x): x is Track => !!x);
    const idx = tracks.findIndex((t) => t.id === item.track_id);
    if (idx >= 0) actions.playFrom(tracks, idx);
  };

  const resolveExternal = async (item: DiscoveryFeedItem): Promise<SearchResult | null> => {
    const key = itemKey(item);
    const cached = resolved().get(key);
    if (cached) return cached;
    const query = `${item.title} ${item.artist}`.trim();
    const found = (await api.searchYouTube(query))[0];
    if (!found) return null;
    setResolved((m) => {
      const next = new Map(m);
      next.set(key, found);
      return next;
    });
    return found;
  };

  const previewExternal = async (item: DiscoveryFeedItem) => {
    const t = toast.loading('Buscando preview…');
    try {
      const r = await resolveExternal(item);
      if (!r) throw new Error('not-found');
      actions.playTrack({
        id: r.id,
        title: item.title || r.title,
        artist: item.artist || r.channel || '',
        album: item.album,
        duration: item.duration || r.duration,
        source: 'preview',
        cover: item.cover || r.thumbnail,
      });
      void api.emitDiscoveryEvent('music_search_played', {
        title: item.title,
        artist: item.artist,
        source: item.source,
        deezer_id: item.deezer_id,
        youtube_id: r.id,
      }).catch(() => {});
      t.update('success', 'Reproduciendo preview');
    } catch {
      t.update('error', 'No se pudo encontrar preview');
    }
  };

  const playItem = (section: DiscoveryFeedSection, item: DiscoveryFeedItem) => {
    if (isExternal(item)) void previewExternal(item);
    else playLocalSection(section, item);
  };

  const saveExternal = async (item: DiscoveryFeedItem, confirmVideoId?: string) => {
    const key = itemKey(item);
    setSaving((s) => new Set(s).add(key));
    try {
      const res = await api.saveDiscoveryTrack({
        artist: item.artist,
        title: item.title,
        duration: item.duration,
        deezer_id: item.deezer_id,
        cover: item.cover,
        confirm_video_id: confirmVideoId,
      });
      if (res.status === 'queued') {
        setReview(null);
        setEnqueued((s) => new Set(s).add(key));
        void refreshDiscover();
        toast.success('Guardado en biblioteca');
        return;
      }
      if (res.status === 'needs_review' && res.candidates?.length) {
        setReview({ item, candidates: res.candidates });
        return;
      }
      toast.error('No se pudo guardar');
    } catch {
      toast.error('No se pudo guardar');
    } finally {
      setSaving((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  };

  const preview = (r: SearchResult) => {
    actions.playTrack({
      id: r.id,
      title: r.title,
      artist: r.channel ?? '',
      duration: r.duration,
      source: 'preview',
      cover: r.thumbnail,
    });
    void api.emitDiscoveryEvent('music_search_played', {
      title: r.title,
      artist: r.channel ?? '',
      source: 'search',
      youtube_id: r.id,
      query: q(),
    }).catch(() => {});
  };

  const add = async (r: SearchResult) => {
    setEnqueued((s) => new Set(s).add(r.id));
    try {
      await api.enqueueDownload([
        {
          source_type: 'youtube_url',
          song_str: `https://www.youtube.com/watch?v=${r.id}`,
          video_id: r.id,
          display_title: r.title,
          display_artist: r.channel,
          thumbnail_url: r.thumbnail,
          duration_sec: r.duration,
          metadata_evidence: null,
        },
      ]);
      void api.emitDiscoveryEvent('music_added_to_queue', {
        title: r.title,
        artist: r.channel ?? '',
        source: 'search',
        youtube_id: r.id,
        query: q(),
      }).catch(() => {});
    } catch {
      setEnqueued((s) => {
        const n = new Set(s);
        n.delete(r.id);
        return n;
      });
    }
  };

  onCleanup(() => {
    requestId += 1;
    aborter?.abort();
    clearTimeout(debounce);
  });

  return (
    <div class="view">
      <div class={styles.bar}>
        <input
          class={styles.input}
          type="search"
          placeholder="Buscar o descubrir música nueva"
          value={q()}
          ref={searchInput}
          onInput={(e) => onInput(e.currentTarget.value)}
        />
      </div>

      <div class={styles.scroll}>
        <Show when={browsing()}>
          <Show
            when={feedSections().length > 0}
            fallback={revalidating() ? <RailSkeletons /> : <SeedDiscover onFocusSearch={() => searchInput?.focus()} />}
          >
            <For each={feedSections()}>
              {(section) => (
                <section class={styles.rail}>
                  <div class={styles.railHead}>
                    <div>
                      <h2 class={styles.railTitle}>{section.title}</h2>
                      <Show when={section.reason}>
                        <p class={styles.railReason}>{section.reason}</p>
                      </Show>
                    </div>
                  </div>
                  <div class={styles.railRow}>
                    <For each={sectionItems(section)}>
                      {(it) => (
                        <Card
                          item={it}
                          cover={itemCover(it)}
                          onClick={() => playItem(section, it)}
                          onSave={isExternal(it) && !it.action_state?.in_library ? () => saveExternal(it) : undefined}
                          saving={saving().has(itemKey(it))}
                          saved={enqueued().has(itemKey(it)) || !!it.action_state?.in_library}
                          onMenu={!isExternal(it) ? (ev) => menuFor(it, ev) : undefined}
                          contextMenu={!isExternal(it) ? () => menuOptsFor(it) : undefined}
                        />
                      )}
                    </For>
                  </div>
                </section>
              )}
            </For>
          </Show>
        </Show>

        <Show when={!browsing()}>
          <div class={styles.results}>
            <Show when={loading() && results().length === 0}>
              <For each={Array.from({ length: 8 })}>{() => <div class={styles.skeleton} />}</For>
            </Show>

            <Show when={!loading() && results().length === 0}>
              <p class={styles.hint}>
                {searchError() ? (
                  <>
                    No se pudo completar la búsqueda.{' '}
                    <button class={styles.seedClear} type="button" onClick={() => run(q())}>
                      Reintentar
                    </button>
                  </>
                ) : (
                  'Sin resultados.'
                )}
              </p>
            </Show>

            <For each={results()}>
              {(r) => (
                <SearchResultRow
                  r={r}
                  active={state.playback.currentTrack?.id === r.id}
                  inLibrary={libYt().has(r.id)}
                  enqueued={enqueued().has(r.id)}
                  onPreview={() => preview(r)}
                  onAdd={() => add(r)}
                />
              )}
            </For>
          </div>
        </Show>
      </div>

      <Show when={review()}>
        {(r) => (
          <div class={styles.modalBackdrop} onClick={() => setReview(null)}>
            <div class={styles.modal} onClick={(e) => e.stopPropagation()}>
              <div class={styles.modalHead}>
                <h2>Elige la versión</h2>
                <button class={styles.closeBtn} type="button" aria-label="Cerrar" onClick={() => setReview(null)}>
                  ×
                </button>
              </div>
              <For each={r().candidates.slice(0, 5)}>
                {(candidate) => (
                  <button
                    class={styles.candidate}
                    type="button"
                    onClick={() => {
                      const id = candidateId(candidate);
                      if (id) void saveExternal(r().item, id);
                    }}
                  >
                    <span class={styles.candidateTitle}>{candidate.title}</span>
                    <span class={styles.candidateSub}>{candidate.channel}</span>
                  </button>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}

function SeedDiscover(props: { onFocusSearch: () => void }) {
  return (
    <div class={styles.seedState}>
      <h2>Busca musica para empezar</h2>
      <p>Discover se genera con artistas, favoritos, playlists y canciones que guardas o reproduces.</p>
      <button class={styles.seedAction} type="button" onClick={props.onFocusSearch}>
        Buscar canciones
      </button>
    </div>
  );
}

interface CardProps {
  item: DiscoveryFeedItem;
  cover?: string;
  onClick: () => void;
  onSave?: () => void;
  saving?: boolean;
  saved?: boolean;
  onMenu?: (ev?: MouseEvent) => void;
  contextMenu?: MenuProvider;
}

function gradientFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 45% 28%), hsl(${(h + 40) % 360} 50% 18%))`;
}

function Card(props: CardProps) {
  const bg = (): JSX.CSSProperties => {
    const grad = gradientFor(itemKey(props.item));
    return props.cover
      ? { background: `url("${props.cover}") center / cover no-repeat, ${grad}` }
      : { background: grad };
  };
  return (
    <div class={styles.card} ref={(el) => props.contextMenu && attachContextMenu(el, props.contextMenu)}>
      <button class={styles.cardBtn} type="button" onClick={props.onClick}>
        <span class={styles.cardCover} style={bg()} />
        <span class={styles.cardTitle}>{props.item.title}</span>
        <span class={styles.cardSub}>{props.item.artist}</span>
      </button>
      <Switch>
        <Match when={props.onSave && !props.saved}>
          <button
            class={styles.saveBtn}
            type="button"
            aria-label="Guardar en biblioteca"
            disabled={props.saving}
            onClick={(e) => {
              e.stopPropagation();
              props.onSave?.();
            }}
          >
            <Show when={props.saving} fallback={<PlusIcon />}>
              <span class={styles.smallSpinner} />
            </Show>
          </button>
        </Match>
        <Match when={props.saved && isExternal(props.item)}>
          <span class={styles.savedBadge} aria-label="Guardado">
            <CheckIcon />
          </span>
        </Match>
      </Switch>
      <Show when={props.onMenu}>
        <button
          class={styles.cardMenu}
          type="button"
          aria-label="Más opciones"
          onClick={(e) => {
            e.stopPropagation();
            props.onMenu!(e);
          }}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="19" cy="12" r="2" />
          </svg>
        </button>
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

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

function RailSkeletons() {
  return (
    <For each={Array.from({ length: 3 })}>
      {() => (
        <section class={styles.rail}>
          <div class={styles.railTitleSkeleton} />
          <div class={styles.railRow}>
            <For each={Array.from({ length: 6 })}>{() => <div class={styles.cardSkeleton} />}</For>
          </div>
        </section>
      )}
    </For>
  );
}
