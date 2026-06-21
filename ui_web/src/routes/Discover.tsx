import { createMemo, createSignal, For, Show, onMount, onCleanup, type JSX } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { api } from '../lib/api';
import { actions, state } from '../stores';
import { coverUrl } from '../lib/media';
import { ensureDiscover, musicSections, recentSaved, topPodcasts, type DiscoverMusicItem } from '../lib/discover';
import { openTrackMenu, trackMenuOptions } from '../components/trackActions';
import { openPlaylistPicker } from '../components/PlaylistPicker';
import { openMetadataEditor } from '../components/MetadataEditor';
import { attachContextMenu, type MenuProvider } from '../lib/contextMenu';
import SearchResultRow from '../components/SearchResultRow';
import { toast } from '../lib/toast';
import type { SearchResult, Track } from '../types/music';
import type { PodcastSearchResult } from '../types/podcast';
import styles from './Discover.module.css';

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/**
 * Discover: instant recommendation rails (stale-while-revalidate, prefetched on
 * boot) plus instant YouTube-Music search with one-tap preview / add / radio.
 */
export default function Discover() {
  const navigate = useNavigate();
  const [q, setQ] = createSignal('');
  const [results, setResults] = createSignal<SearchResult[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [searchError, setSearchError] = createSignal(false);
  const [enqueued, setEnqueued] = createSignal<Set<string>>(new Set());
  const [seed, setSeed] = createSignal<string | null>(null);

  const libYt = createMemo(() => new Set(state.library.map((t) => t.youtube_id).filter((x): x is string => !!x)));
  const libById = createMemo(() => new Map(state.library.map((t) => [t.id, t] as const)));
  const browsing = () => !q().trim() && !seed();

  const cache = new Map<string, SearchResult[]>();
  let aborter: AbortController | undefined;
  let debounce: number | undefined;
  let requestId = 0;

  onMount(() => ensureDiscover());

  const run = (query: string) => {
    query = query.trim();
    setSeed(null);
    const currentRequest = ++requestId;
    aborter?.abort();
    aborter = undefined;
    setSearchError(false);
    if (query.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    const cached = cache.get(query);
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
        cache.set(query, res);
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
    debounce = window.setTimeout(() => run(v), 250);
  };

  const radio = (r: SearchResult) => {
    aborter?.abort();
    aborter = new AbortController();
    setSeed(r.title);
    setLoading(true);
    api
      .relatedYouTube(r.id, aborter.signal)
      .then((res) => setResults(res))
      .catch((e) => {
        if (!isAbort(e)) setResults([]);
      })
      .finally(() => setLoading(false));
  };

  const preview = (r: SearchResult) => {
    const track: Track = {
      id: r.id,
      title: r.title,
      artist: r.channel ?? '',
      duration: r.duration,
      source: 'preview',
      cover: r.thumbnail,
    };
    actions.playTrack(track);
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
    } catch {
      setEnqueued((s) => {
        const n = new Set(s);
        n.delete(r.id);
        return n;
      });
    }
  };

  // ── Rails ──
  const toTrack = (item: DiscoverMusicItem): Track =>
    libById().get(item.track_id) ?? {
      id: item.track_id,
      title: item.title,
      artist: item.artist,
      album: item.album,
      duration: item.duration,
    };

  const playSection = (items: DiscoverMusicItem[], i: number) => actions.playFrom(items.map(toTrack), i);

  const trackCtx = () => ({ navigate, onAddToPlaylist: openPlaylistPicker, onEditMetadata: openMetadataEditor });
  const menuOptsFor = (item: DiscoverMusicItem) => trackMenuOptions(toTrack(item), trackCtx());
  const menuFor = (item: DiscoverMusicItem, ev?: MouseEvent) => openTrackMenu(toTrack(item), trackCtx(), ev);

  const subscribe = async (p: PodcastSearchResult) => {
    const t = toast.loading('Suscribiendo…');
    try {
      await api.subscribePodcast({
        rss_url: p.feed_url,
        title: p.title,
        author: p.author,
        image_url: p.image_url,
        itunes_collection_id: p.itunes_collection_id,
      });
      await actions.syncLibrary();
      t.update('success', `Suscrito a ${p.title}`);
    } catch {
      t.update('error', 'No se pudo suscribir');
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
          placeholder="Buscar canciones, artistas…"
          value={q()}
          onInput={(e) => onInput(e.currentTarget.value)}
        />
      </div>

      <div class={styles.scroll}>
        {/* ── Browse mode: recommendation rails ── */}
        <Show when={browsing()}>
          <Show
            when={musicSections().length > 0 || recentSaved().length > 0 || topPodcasts().length > 0}
            fallback={<RailSkeletons />}
          >
            <Show when={recentSaved().length > 0}>
              <section class={styles.rail}>
                <h2 class={styles.railTitle}>Guardado recientemente</h2>
                <div class={styles.railRow}>
                  <For each={recentSaved()}>
                    {(it) => (
                      <Card
                        cover={it.in_library ? coverUrl(it.track_id) : it.cover}
                        title={it.title}
                        subtitle={it.artist}
                        seedId={it.track_id}
                        onClick={() => {
                          const t = libById().get(it.track_id);
                          if (t) actions.playTrack(t);
                        }}
                      />
                    )}
                  </For>
                </div>
              </section>
            </Show>

            <For each={musicSections()}>
              {(sec) => (
                <section class={styles.rail}>
                  <h2 class={styles.railTitle}>{sec.title}</h2>
                  <Show when={sec.reason}>
                    <p class={styles.railReason}>{sec.reason}</p>
                  </Show>
                  <div class={styles.railRow}>
                    <For each={sec.items}>
                      {(it, i) => (
                        <Card
                          cover={coverUrl(it.track_id)}
                          title={it.title}
                          subtitle={it.artist}
                          seedId={it.track_id}
                          onClick={() => playSection(sec.items, i())}
                          onMenu={(ev) => menuFor(it, ev)}
                          contextMenu={() => menuOptsFor(it)}
                        />
                      )}
                    </For>
                  </div>
                </section>
              )}
            </For>

            <Show when={topPodcasts().length > 0}>
              <section class={styles.rail}>
                <h2 class={styles.railTitle}>Podcasts populares</h2>
                <div class={styles.railRow}>
                  <For each={topPodcasts()}>
                    {(p) => (
                      <Card cover={p.image_url} title={p.title} subtitle={p.author} round seedId={p.feed_url} onClick={() => subscribe(p)} />
                    )}
                  </For>
                </div>
              </section>
            </Show>
          </Show>
        </Show>

        {/* ── Search / radio results ── */}
        <Show when={!browsing()}>
          <Show when={seed()}>
            <p class={styles.seed}>
              Radio basada en <strong>{seed()}</strong>{' '}
              <button class={styles.seedClear} type="button" onClick={() => setSeed(null)}>
                cerrar
              </button>
            </p>
          </Show>

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
                onRadio={() => radio(r)}
              />
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}

interface CardProps {
  cover?: string;
  title: string;
  subtitle?: string;
  /** Used for the deterministic gradient fallback. */
  seedId: string;
  round?: boolean;
  onClick: () => void;
  onMenu?: (ev?: MouseEvent) => void;
  /** Right-click / long-press contextual menu for the card. */
  contextMenu?: MenuProvider;
}

function gradientFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 45% 28%), hsl(${(h + 40) % 360} 50% 18%))`;
}

function Card(props: CardProps) {
  const bg = (): JSX.CSSProperties => {
    const grad = gradientFor(props.seedId);
    return props.cover
      ? { background: `url("${props.cover}") center / cover no-repeat, ${grad}` }
      : { background: grad };
  };
  return (
    <div class={styles.card} ref={(el) => props.contextMenu && attachContextMenu(el, props.contextMenu)}>
      <button class={styles.cardBtn} type="button" onClick={props.onClick}>
        <span classList={{ [styles.cardCover]: true, [styles.round]: props.round }} style={bg()} />
        <span class={styles.cardTitle}>{props.title}</span>
        <Show when={props.subtitle}>
          <span class={styles.cardSub}>{props.subtitle}</span>
        </Show>
      </button>
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
