import { createMemo, createSignal, For, Show, onCleanup } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { api } from '../lib/api';
import { actions, state } from '../stores';
import { coverUrl } from '../lib/media';
import SongRow from '../components/SongRow';
import SearchResultRow from '../components/SearchResultRow';
import { openTrackMenu } from '../components/trackActions';
import { openPlaylistPicker } from '../components/PlaylistPicker';
import { openMetadataEditor } from '../components/MetadataEditor';
import { openPlayOnDevice } from '../components/DeviceSheet';
import type { SearchResult, Track } from '../types/music';
import styles from './Search.module.css';

const LIBRARY_CAP = 50;

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/**
 * Unified search: instant local-library matches (title/artist/album) plus
 * debounced online (YouTube / YouTube-Music) results you can preview and add
 * to the library. A search-suggest typeahead helps refine the query.
 */
export default function Search() {
  const navigate = useNavigate();
  const [q, setQ] = createSignal('');
  const [online, setOnline] = createSignal<SearchResult[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [searchError, setSearchError] = createSignal(false);
  const [suggestions, setSuggestions] = createSignal<string[]>([]);
  const [showSuggest, setShowSuggest] = createSignal(false);
  const [enqueued, setEnqueued] = createSignal<Set<string>>(new Set());

  const libYt = createMemo(
    () => new Set(state.library.map((t) => t.youtube_id).filter((x): x is string => !!x)),
  );

  // Instant client-side library filter (capped so a broad query stays snappy
  // without virtualization).
  const libraryMatches = createMemo<Track[]>(() => {
    const query = q().trim().toLowerCase();
    if (!query) return [];
    const out: Track[] = [];
    for (const t of state.library) {
      if (
        t.title?.toLowerCase().includes(query) ||
        t.artist?.toLowerCase().includes(query) ||
        (t.album ?? '').toLowerCase().includes(query)
      ) {
        out.push(t);
        if (out.length >= LIBRARY_CAP) break;
      }
    }
    return out;
  });

  const cache = new Map<string, SearchResult[]>();
  let aborter: AbortController | undefined;
  let suggestAborter: AbortController | undefined;
  let searchDebounce: number | undefined;
  let suggestDebounce: number | undefined;
  let requestId = 0;

  const runOnline = (query: string) => {
    query = query.trim();
    const currentRequest = ++requestId;
    aborter?.abort();
    aborter = undefined;
    setSearchError(false);
    if (query.length < 2) {
      setOnline([]);
      setLoading(false);
      return;
    }
    const cached = cache.get(query);
    if (cached) {
      setOnline(cached);
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
        setOnline(res);
      })
      .catch((e) => {
        if (currentRequest !== requestId || isAbort(e)) return;
        setOnline([]);
        setSearchError(true);
      })
      .finally(() => {
        if (currentRequest === requestId) setLoading(false);
      });
  };

  const runSuggest = (query: string) => {
    query = query.trim();
    suggestAborter?.abort();
    if (query.length < 2) {
      setSuggestions([]);
      return;
    }
    suggestAborter = new AbortController();
    api
      .suggest(query, suggestAborter.signal)
      .then((s) => setSuggestions(s.slice(0, 8)))
      .catch(() => {});
  };

  const onInput = (v: string) => {
    setQ(v);
    setShowSuggest(true);
    clearTimeout(searchDebounce);
    clearTimeout(suggestDebounce);
    searchDebounce = window.setTimeout(() => runOnline(v), 250);
    suggestDebounce = window.setTimeout(() => runSuggest(v), 120);
  };

  const commit = (v: string) => {
    setQ(v);
    setShowSuggest(false);
    setSuggestions([]);
    clearTimeout(searchDebounce);
    runOnline(v);
  };

  let hideTimer: number | undefined;
  const onBlur = () => {
    hideTimer = window.setTimeout(() => setShowSuggest(false), 120);
  };
  const pickSuggestion = (s: string) => {
    clearTimeout(hideTimer);
    commit(s);
  };

  // ── Library row wiring (mirrors TrackList) ──
  const goArtist = (artist: string) => artist && navigate(`/artist/${encodeURIComponent(artist)}`);
  const openMenu = (track: Track) =>
    openTrackMenu(track, {
      navigate,
      onAddToPlaylist: openPlaylistPicker,
      onEditMetadata: openMetadataEditor,
      onPlayOnDevice: openPlayOnDevice,
    });

  // ── Online row wiring (mirrors Discover) ──
  const preview = (r: SearchResult) => {
    actions.playTrack({
      id: r.id,
      title: r.title,
      artist: r.channel ?? '',
      duration: r.duration,
      source: 'preview',
      cover: r.thumbnail,
    });
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

  onCleanup(() => {
    requestId += 1;
    aborter?.abort();
    suggestAborter?.abort();
    clearTimeout(searchDebounce);
    clearTimeout(suggestDebounce);
    clearTimeout(hideTimer);
  });

  return (
    <div class="view">
      <div class={styles.searchBox}>
        <div class={styles.bar}>
          <input
            class={styles.input}
            type="search"
            placeholder="Buscar en tu biblioteca y en internet"
            value={q()}
            onInput={(e) => onInput(e.currentTarget.value)}
            onFocus={() => suggestions().length > 0 && setShowSuggest(true)}
            onBlur={onBlur}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit(e.currentTarget.value);
              else if (e.key === 'Escape') setShowSuggest(false);
            }}
            autofocus
          />
        </div>
        <Show when={showSuggest() && suggestions().length > 0}>
          <ul class={styles.suggest}>
            <For each={suggestions()}>
              {(s) => (
                <li>
                  <button
                    class={styles.suggestItem}
                    type="button"
                    onClick={() => pickSuggestion(s)}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                      <circle cx="11" cy="11" r="7" />
                      <path d="M21 21l-4.3-4.3" />
                    </svg>
                    <span>{s}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>

      <div class={styles.scroll}>
        <Show when={q().trim()} fallback={<p class={styles.hint}>Escribe para buscar en tu biblioteca y en internet.</p>}>
          <Show when={libraryMatches().length > 0}>
            <section>
              <h2 class={styles.section}>En tu biblioteca</h2>
              <For each={libraryMatches()}>
                {(track, i) => (
                  <SongRow
                    track={track}
                    cover={coverUrl(track.id)}
                    active={state.playback.currentTrack?.id === track.id}
                    onPlay={() => actions.playFrom(libraryMatches(), i())}
                    onArtist={goArtist}
                    onMenu={openMenu}
                  />
                )}
              </For>
            </section>
          </Show>

          <section>
            <h2 class={styles.section}>En internet</h2>
            <Show when={loading() && online().length === 0}>
              <For each={Array.from({ length: 6 })}>{() => <div class={styles.skeleton} />}</For>
            </Show>

            <Show when={!loading() && online().length === 0}>
              <p class={styles.hint}>
                {searchError() ? (
                  <>
                    No se pudo completar la búsqueda.{' '}
                    <button class={styles.retry} type="button" onClick={() => runOnline(q())}>
                      Reintentar
                    </button>
                  </>
                ) : q().trim().length < 2 ? (
                  'Sigue escribiendo para buscar online…'
                ) : (
                  'Sin resultados online.'
                )}
              </p>
            </Show>

            <For each={online()}>
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
          </section>
        </Show>
      </div>
    </div>
  );
}
