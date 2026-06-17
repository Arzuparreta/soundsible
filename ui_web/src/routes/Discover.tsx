import { createMemo, createSignal, For, Show, onCleanup, type JSX } from 'solid-js';
import { api } from '../lib/api';
import { actions, state } from '../stores';
import type { SearchResult, Track } from '../types/music';
import styles from './Discover.module.css';

function fmtDur(s?: number): string {
  if (s == null || !Number.isFinite(s)) return '';
  const m = Math.floor(s / 60);
  const x = Math.floor(s % 60);
  return `${m}:${x.toString().padStart(2, '0')}`;
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/**
 * Discover: instant YouTube-Music search (debounced + cancelable + cached),
 * one-tap preview (no download), one-tap add to library, and a "radio" that
 * pulls related tracks for endless discovery. All overlays/actions are managed
 * — the legacy resolution-sheet body leak cannot happen here.
 */
export default function Discover() {
  const [q, setQ] = createSignal('');
  const [results, setResults] = createSignal<SearchResult[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [enqueued, setEnqueued] = createSignal<Set<string>>(new Set());
  const [seed, setSeed] = createSignal<string | null>(null);

  // YouTube ids already in the library → show "in library" instead of "add".
  const libYt = createMemo(() => new Set(state.library.map((t) => t.youtube_id).filter((x): x is string => !!x)));

  const cache = new Map<string, SearchResult[]>();
  let aborter: AbortController | undefined;
  let debounce: number | undefined;

  const run = (query: string) => {
    query = query.trim();
    setSeed(null);
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
    aborter?.abort();
    aborter = new AbortController();
    setLoading(true);
    api
      .searchYouTube(query, aborter.signal)
      .then((res) => {
        cache.set(query, res);
        setResults(res);
      })
      .catch((e) => {
        if (!isAbort(e)) setResults([]);
      })
      .finally(() => setLoading(false));
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

  onCleanup(() => {
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
          autofocus
        />
      </div>

      <div class={styles.scroll}>
        <Show when={seed()}>
          <p class={styles.seed}>
            Radio basada en <strong>{seed()}</strong>
          </p>
        </Show>

        <Show when={loading() && results().length === 0}>
          <For each={Array.from({ length: 8 })}>{() => <div class={styles.skeleton} />}</For>
        </Show>

        <Show when={!loading() && results().length === 0}>
          <p class={styles.hint}>
            {q().trim()
              ? 'Sin resultados.'
              : 'Busca cualquier canción o artista. Escucha al instante, añade con un toque, abre la radio para descubrir más.'}
          </p>
        </Show>

        <For each={results()}>
          {(r) => (
            <ResultRow
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
      </div>
    </div>
  );
}

interface RowProps {
  r: SearchResult;
  active: boolean;
  inLibrary: boolean;
  enqueued: boolean;
  onPreview: () => void;
  onAdd: () => void;
  onRadio: () => void;
}

function ResultRow(props: RowProps) {
  const bg = (): JSX.CSSProperties =>
    props.r.thumbnail
      ? { background: `url("${props.r.thumbnail}") center / cover no-repeat, var(--bg-raised)` }
      : { background: 'var(--bg-raised)' };

  return (
    <div classList={{ [styles.row]: true, [styles.active]: props.active }} onClick={props.onPreview}>
      <div class={styles.cover} style={bg()} />
      <div class={styles.meta}>
        <span class={styles.title}>{props.r.title}</span>
        <span class={styles.sub}>{props.r.channel}</span>
      </div>
      <span class={styles.dur}>{fmtDur(props.r.duration)}</span>
      <button
        class={styles.iconBtn}
        type="button"
        aria-label="Radio: más como esto"
        onClick={(e) => {
          e.stopPropagation();
          props.onRadio();
        }}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M4 12a8 8 0 018-8M4 12a8 8 0 008 8M8 12a4 4 0 014-4" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
        </svg>
      </button>
      <Show
        when={props.inLibrary}
        fallback={
          <Show
            when={props.enqueued}
            fallback={
              <button
                class={styles.addBtn}
                type="button"
                aria-label="Añadir a biblioteca"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onAdd();
                }}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            }
          >
            <span class={styles.spinner} aria-label="Descargando" />
          </Show>
        }
      >
        <span class={styles.done} aria-label="En biblioteca">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M5 12l5 5L20 7" />
          </svg>
        </span>
      </Show>
    </div>
  );
}
