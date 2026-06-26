import { createMemo, createSignal, For, Match, Show, Switch, onCleanup, type JSX } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { api } from '../lib/api';
import { actions, state } from '../stores';
import { coverUrl } from '../lib/media';
import { artistPath } from '../lib/artistRoute';
import { toast } from '../lib/toast';
import type { CatalogItem, CatalogSaveResponse, Track } from '../types/music';
import styles from './Search.module.css';

type SearchTab = 'all' | 'track,library_track' | 'artist' | 'album';

const tabs: Array<{ id: SearchTab; label: string }> = [
  { id: 'all', label: 'Todo' },
  { id: 'track,library_track', label: 'Canciones' },
  { id: 'artist', label: 'Artistas' },
  { id: 'album', label: 'Albums' },
];

const RECENTS_KEY = 'catalog_search_recents';

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

function formatDuration(seconds?: number): string {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function gradientFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 46% 31%), hsl(${(h + 42) % 360} 54% 18%))`;
}

function loadRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

function saveRecents(values: string[]): void {
  localStorage.setItem(RECENTS_KEY, JSON.stringify(values.slice(0, 8)));
}

function itemArtist(item: CatalogItem): string {
  return item.artist || item.subtitle || '';
}

function itemTrack(item: CatalogItem): Track | null {
  if (item.track_id) {
    const found = state.library.find((t) => t.id === item.track_id);
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

function candidateVideoId(candidate: Record<string, unknown>): string {
  return String(candidate.video_id || candidate.id || '');
}

export default function Search() {
  const navigate = useNavigate();
  const [q, setQ] = createSignal('');
  const [tab, setTab] = createSignal<SearchTab>('all');
  const [items, setItems] = createSignal<CatalogItem[]>([]);
  const [sectionIds, setSectionIds] = createSignal<Record<string, string[]>>({});
  const [loading, setLoading] = createSignal(false);
  const [searchError, setSearchError] = createSignal(false);
  const [suggestions, setSuggestions] = createSignal<string[]>([]);
  const [showSuggest, setShowSuggest] = createSignal(false);
  const [recents, setRecents] = createSignal<string[]>(loadRecents());
  const [saving, setSaving] = createSignal<Set<string>>(new Set());
  const [saved, setSaved] = createSignal<Set<string>>(new Set());
  const [review, setReview] = createSignal<{ item: CatalogItem; response: CatalogSaveResponse } | null>(null);

  let aborter: AbortController | undefined;
  let suggestAborter: AbortController | undefined;
  let debounce: number | undefined;
  let suggestDebounce: number | undefined;
  let requestId = 0;

  const byId = createMemo(() => new Map(items().map((item) => [item.id, item] as const)));
  const top = createMemo(() => items()[0]);
  const songs = createMemo(() =>
    (sectionIds().songs ?? [])
      .map((id) => byId().get(id))
      .filter((item): item is CatalogItem => !!item)
      .concat(items().filter((item) => ['track', 'library_track'].includes(item.type) && item.id !== top()?.id))
      .filter((item, idx, arr) => arr.findIndex((x) => x.id === item.id) === idx)
      .slice(0, 18),
  );
  const artists = createMemo(() =>
    (sectionIds().artists ?? [])
      .map((id) => byId().get(id))
      .filter((item): item is CatalogItem => !!item)
      .concat(items().filter((item) => item.type === 'artist' && item.id !== top()?.id))
      .filter((item, idx, arr) => arr.findIndex((x) => x.id === item.id) === idx)
      .slice(0, 12),
  );
  const albums = createMemo(() =>
    (sectionIds().albums ?? [])
      .map((id) => byId().get(id))
      .filter((item): item is CatalogItem => !!item)
      .concat(items().filter((item) => item.type === 'album' && item.id !== top()?.id))
      .filter((item, idx, arr) => arr.findIndex((x) => x.id === item.id) === idx)
      .slice(0, 12),
  );

  const run = (query: string, nextTab = tab()) => {
    query = query.trim();
    const current = ++requestId;
    aborter?.abort();
    aborter = undefined;
    setSearchError(false);
    if (query.length < 2) {
      setItems([]);
      setSectionIds({});
      setLoading(false);
      return;
    }
    aborter = new AbortController();
    setLoading(true);
    api
      .searchCatalog(query, aborter.signal, nextTab)
      .then((res) => {
        if (current !== requestId) return;
        setItems(res.items ?? []);
        const nextSections: Record<string, string[]> = {};
        for (const section of res.sections ?? []) nextSections[section.id] = section.item_ids ?? [];
        setSectionIds(nextSections);
      })
      .catch((e) => {
        if (current !== requestId || isAbort(e)) return;
        setItems([]);
        setSectionIds({});
        setSearchError(true);
      })
      .finally(() => {
        if (current === requestId) setLoading(false);
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
    api.suggestCatalog(query, suggestAborter.signal).then((s) => setSuggestions(s)).catch(() => {});
  };

  const commit = (value: string) => {
    const query = value.trim();
    setQ(query);
    setShowSuggest(false);
    setSuggestions([]);
    clearTimeout(debounce);
    clearTimeout(suggestDebounce);
    run(query);
    if (query.length >= 2) {
      const next = [query, ...recents().filter((x) => x.toLowerCase() !== query.toLowerCase())].slice(0, 8);
      setRecents(next);
      saveRecents(next);
    }
  };

  const onInput = (value: string) => {
    setQ(value);
    setShowSuggest(true);
    clearTimeout(debounce);
    clearTimeout(suggestDebounce);
    debounce = window.setTimeout(() => run(value), 220);
    suggestDebounce = window.setTimeout(() => runSuggest(value), 120);
  };

  const setActiveTab = (next: SearchTab) => {
    setTab(next);
    run(q(), next);
  };

  const coverStyle = (item: CatalogItem, round = false): JSX.CSSProperties => {
    const grad = gradientFor(item.id);
    const url = item.cover || (item.track_id ? coverUrl(item.track_id) : '');
    return {
      background: url ? `url("${url}") center / cover no-repeat, ${grad}` : grad,
      'border-radius': round ? 'var(--radius-full)' : undefined,
    };
  };

  const previewExternal = async (item: CatalogItem) => {
    const artist = itemArtist(item);
    if (!artist || !item.title) return;
    const t = toast.loading('Buscando preview...');
    try {
      const resolved = await api.resolveCatalogItem({ artist, title: item.title, duration: item.duration });
      if (!resolved.video_id) throw new Error('not-found');
      actions.playTrack({
        id: resolved.video_id,
        title: item.title,
        artist,
        album: item.album,
        duration: item.duration,
        cover: item.cover,
        source: 'preview',
      });
      t.update('success', 'Reproduciendo preview');
    } catch {
      t.update('error', 'No se pudo encontrar preview');
    }
  };

  const playItem = (item: CatalogItem) => {
    const track = itemTrack(item);
    if (track) {
      actions.playTrack(track);
      return;
    }
    if (item.type === 'track') void previewExternal(item);
    else if (item.type === 'artist') {
      const artist = itemArtist(item) || item.title;
      const hasLocal = state.library.some((t) => t.artist === artist || t.album_artist === artist);
      if (hasLocal) navigate(artistPath(artist));
      else commit(artist);
    } else if (item.type === 'album') {
      commit(`${item.title} ${itemArtist(item)}`.trim());
    }
  };

  const saveItem = async (item: CatalogItem, confirmVideoId?: string) => {
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
        confirm_video_id: confirmVideoId,
      });
      if (response.status === 'queued') {
        setReview(null);
        setSaved((s) => new Set(s).add(item.id));
        toast.success('Añadido a descargas');
      } else if (response.status === 'needs_review') {
        setReview({ item, response });
      } else {
        toast.error('No se pudo guardar');
      }
    } catch {
      toast.error('No se pudo guardar');
    } finally {
      setSaving((s) => {
        const next = new Set(s);
        next.delete(item.id);
        return next;
      });
    }
  };

  onCleanup(() => {
    requestId += 1;
    aborter?.abort();
    suggestAborter?.abort();
    clearTimeout(debounce);
    clearTimeout(suggestDebounce);
  });

  return (
    <div class="view">
      <div class={styles.searchBox}>
        <div class={styles.bar}>
          <input
            class={styles.input}
            type="search"
            placeholder="Que quieres escuchar?"
            value={q()}
            onInput={(e) => onInput(e.currentTarget.value)}
            onFocus={() => setShowSuggest(true)}
            onBlur={() => setShowSuggest(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit(e.currentTarget.value);
              if (e.key === 'Escape') setShowSuggest(false);
            }}
            autofocus
          />
        </div>
        <Show when={showSuggest() && q().trim().length >= 2 && suggestions().length > 0}>
          <div class={styles.suggest}>
            <For each={suggestions()}>
              {(value) => (
                <button class={styles.suggestItem} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => commit(value)}>
                  <SearchIcon />
                  <span>{value}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>

      <Show when={q().trim().length >= 2}>
        <div class={styles.tabs}>
          <For each={tabs}>
            {(t) => (
              <button
                classList={{ [styles.tab]: true, [styles.activeTab]: tab() === t.id }}
                type="button"
                onClick={() => setActiveTab(t.id)}
              >
                {t.label}
              </button>
            )}
          </For>
        </div>
      </Show>

      <div class={styles.scroll}>
        <Switch>
          <Match when={!q().trim()}>
            <StartPanel recents={recents()} onPick={commit} />
          </Match>
          <Match when={loading() && items().length === 0}>
            <div class={styles.skeletonGrid}>
              <For each={Array.from({ length: 8 })}>{() => <div class={styles.skeleton} />}</For>
            </div>
          </Match>
          <Match when={!loading() && items().length === 0}>
            <p class={styles.hint}>
              {searchError() ? (
                <>
                  No se pudo completar la busqueda.{' '}
                  <button class={styles.retry} type="button" onClick={() => run(q())}>
                    Reintentar
                  </button>
                </>
              ) : (
                'Sin resultados.'
              )}
            </p>
          </Match>
          <Match when={true}>
            <div class={styles.results}>
              <Show when={top()}>
                {(item) => (
                  <section class={styles.topSection}>
                    <h2 class={styles.sectionTitle}>Top result</h2>
                    <TopResult
                      item={item()}
                      coverStyle={coverStyle}
                      saving={saving().has(item().id)}
                      saved={saved().has(item().id) || !!item().action_state?.in_library}
                      onPlay={() => playItem(item())}
                      onSave={() => saveItem(item())}
                    />
                  </section>
                )}
              </Show>

              <Show when={songs().length > 0}>
                <section class={styles.section}>
                  <h2 class={styles.sectionTitle}>Canciones</h2>
                  <For each={songs()}>
                    {(item) => (
                      <SongResult
                        item={item}
                        coverStyle={coverStyle}
                        active={state.playback.currentTrack?.id === (item.track_id || item.id)}
                        saving={saving().has(item.id)}
                        saved={saved().has(item.id) || !!item.action_state?.in_library}
                        onPlay={() => playItem(item)}
                        onSave={() => saveItem(item)}
                      />
                    )}
                  </For>
                </section>
              </Show>

              <Show when={artists().length > 0}>
                <CardSection title="Artistas" items={artists()} round coverStyle={coverStyle} onPick={playItem} />
              </Show>

              <Show when={albums().length > 0}>
                <CardSection title="Albums" items={albums()} coverStyle={coverStyle} onPick={playItem} />
              </Show>
            </div>
          </Match>
        </Switch>
      </div>

      <Show when={review()}>
        {(r) => (
          <div class={styles.modalBackdrop} onClick={() => setReview(null)}>
            <div class={styles.modal} onClick={(e) => e.stopPropagation()}>
              <div class={styles.modalHead}>
                <h2>Elige la version</h2>
                <button class={styles.closeBtn} type="button" aria-label="Cerrar" onClick={() => setReview(null)}>
                  x
                </button>
              </div>
              <For each={(r().response.candidates ?? []).slice(0, 5)}>
                {(candidate) => (
                  <button
                    class={styles.candidate}
                    type="button"
                    onClick={() => {
                      const id = candidateVideoId(candidate);
                      if (id) void saveItem(r().item, id);
                    }}
                  >
                    <span class={styles.candidateTitle}>{String(candidate.title || '')}</span>
                    <span class={styles.candidateSub}>{String(candidate.channel || '')}</span>
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

function StartPanel(props: { recents: string[]; onPick: (value: string) => void }) {
  return (
    <div class={styles.start}>
      <Show when={props.recents.length > 0}>
        <section>
          <h2 class={styles.sectionTitle}>Busquedas recientes</h2>
          <div class={styles.recentGrid}>
            <For each={props.recents}>
              {(value) => (
                <button class={styles.recent} type="button" onClick={() => props.onPick(value)}>
                  <SearchIcon />
                  <span>{value}</span>
                </button>
              )}
            </For>
          </div>
        </section>
      </Show>
    </div>
  );
}

function TopResult(props: {
  item: CatalogItem;
  coverStyle: (item: CatalogItem, round?: boolean) => JSX.CSSProperties;
  saving: boolean;
  saved: boolean;
  onPlay: () => void;
  onSave: () => void;
}) {
  const canSave = () => props.item.type === 'track' && !props.saved;
  return (
    <div class={styles.topCard}>
      <button class={styles.topMain} type="button" onClick={props.onPlay}>
        <span class={styles.topCover} style={props.coverStyle(props.item, props.item.type === 'artist')} />
        <span class={styles.topMeta}>
          <span class={styles.topTitle}>{props.item.title}</span>
          <span class={styles.topSub}>{props.item.subtitle || itemArtist(props.item)}</span>
          <span class={styles.pill}>{labelFor(props.item)}</span>
        </span>
      </button>
      <Show when={canSave()}>
        <button class={styles.primaryIcon} type="button" disabled={props.saving} aria-label="Guardar" onClick={props.onSave}>
          <Show when={props.saving} fallback={<PlusIcon />}>
            <span class={styles.spinner} />
          </Show>
        </button>
      </Show>
    </div>
  );
}

function SongResult(props: {
  item: CatalogItem;
  coverStyle: (item: CatalogItem, round?: boolean) => JSX.CSSProperties;
  active: boolean;
  saving: boolean;
  saved: boolean;
  onPlay: () => void;
  onSave: () => void;
}) {
  const canSave = () => props.item.type === 'track' && !props.saved;
  return (
    <div classList={{ [styles.songRow]: true, [styles.activeSong]: props.active }} onClick={props.onPlay}>
      <span class={styles.songCover} style={props.coverStyle(props.item)} />
      <span class={styles.songMeta}>
        <span class={styles.songTitle}>{props.item.title}</span>
        <span class={styles.songSub}>{props.item.subtitle || itemArtist(props.item)}</span>
      </span>
      <span class={styles.source}>{props.item.source}</span>
      <span class={styles.duration}>{formatDuration(props.item.duration)}</span>
      <Show when={props.saved}>
        <span class={styles.done} aria-label="En biblioteca">
          <CheckIcon />
        </span>
      </Show>
      <Show when={canSave()}>
        <button
          class={styles.iconBtn}
          type="button"
          disabled={props.saving}
          aria-label="Guardar"
          onClick={(e) => {
            e.stopPropagation();
            props.onSave();
          }}
        >
          <Show when={props.saving} fallback={<PlusIcon />}>
            <span class={styles.spinner} />
          </Show>
        </button>
      </Show>
    </div>
  );
}

function CardSection(props: {
  title: string;
  items: CatalogItem[];
  round?: boolean;
  coverStyle: (item: CatalogItem, round?: boolean) => JSX.CSSProperties;
  onPick: (item: CatalogItem) => void;
}) {
  return (
    <section class={styles.section}>
      <h2 class={styles.sectionTitle}>{props.title}</h2>
      <div class={styles.cardGrid}>
        <For each={props.items}>
          {(item) => (
            <button class={styles.card} type="button" onClick={() => props.onPick(item)}>
              <span class={styles.cardCover} style={props.coverStyle(item, props.round)} />
              <span class={styles.cardTitle}>{item.title}</span>
              <span class={styles.cardSub}>{item.subtitle || itemArtist(item)}</span>
            </button>
          )}
        </For>
      </div>
    </section>
  );
}

function labelFor(item: CatalogItem): string {
  if (item.type === 'library_track') return 'En tu biblioteca';
  if (item.type === 'track') return 'Cancion';
  if (item.type === 'artist') return 'Artista';
  if (item.type === 'album') return 'Album';
  return 'Playlist';
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
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
