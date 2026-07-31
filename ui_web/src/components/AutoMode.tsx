import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { actions, isSavedTrack, state } from '../stores';
import { api, type DjProfile } from '../lib/api';
import { coverUrl } from '../lib/media';
import { t } from '../lib/i18n';
import { createResponsiveTap } from '../lib/responsiveTap';
import type { AutoActivity } from '../lib/generatedQueue';
import { parseDjDirection, parseNamedRequest } from '../lib/djDirection';
import { queueIdentity } from '../lib/queueDiscovery';
import { isPodcastTrack } from '../lib/track';
import { savedFromTrack } from '../lib/saved';
import { FavouriteButton } from './FavouriteButton';
import { CollectionButton } from './CollectionButton';
import { LyricsPanel } from './LyricsPanel';
import styles from './AutoMode.module.css';
import { clockTime } from '../lib/format';
import type { CatalogItem, Track } from '../types/music';

const IDLE_MS = 12_000;
type AutoMobilePanel = 'closed' | 'booth' | 'route';

const DJ_PROFILES: Array<{ id: DjProfile; titleKey: string; traitKey: string }> = [
  { id: 'adaptive', titleKey: 'autoMode.dj.adaptive', traitKey: 'autoMode.dj.adaptiveTrait' },
  { id: 'long_blend', titleKey: 'autoMode.dj.longBlend', traitKey: 'autoMode.dj.longBlendTrait' },
  { id: 'cuts_drops', titleKey: 'autoMode.dj.cutsDrops', traitKey: 'autoMode.dj.cutsDropsTrait' },
  { id: 'open_format', titleKey: 'autoMode.dj.openFormat', traitKey: 'autoMode.dj.openFormatTrait' },
];

const DIRECTION_LEVELS = [-0.65, 0, 0.65] as const;

/** Which of the three switch positions a stored direction value sits at. */
function directionIndex(value: number): 0 | 1 | 2 {
  if (value < -0.25) return 0;
  if (value > 0.25) return 2;
  return 1;
}

/**
 * A three-position switch.
 *
 * Deliberately not three buttons that happen to be adjacent: the travelling
 * thumb is what makes it read as a control with a *setting* rather than a menu
 * with a highlight. The booth has two of these and they are the only things on
 * this surface that move.
 */
function DirectionSwitch(props: {
  label: string;
  options: string[];
  notes: string[];
  value: number;
  onPick: (value: number, note: string) => void;
}) {
  const index = () => directionIndex(props.value);
  return (
    <fieldset class={styles.switchGroup}>
      <legend>{props.label}</legend>
      <div class={styles.switchTrack} style={{ '--switch-pos': index() }}>
        <span class={styles.switchThumb} aria-hidden="true" />
        <For each={DIRECTION_LEVELS}>
          {(level, position) => (
            <button
              type="button"
              aria-pressed={index() === position()}
              onClick={() => props.onPick(level, props.notes[position()])}
            >
              {props.options[position()]}
            </button>
          )}
        </For>
      </div>
    </fieldset>
  );
}

/** `128` from a raw BPM, or an em dash. The booth never shows a made-up number. */
function bpmText(value?: number): string {
  return value && Number.isFinite(value) ? String(Math.round(value)) : '—';
}

function techniqueText(technique?: string): string {
  if (!technique) return t('autoMode.dj.analysing');
  const key = `autoMode.dj.technique.${technique}`;
  const translated = t(key);
  return translated === key ? technique.replaceAll('_', ' ') : translated;
}

/**
 * Type-size tier for a track title.
 *
 * Auto Mode gives the title a fixed two-line well so the artwork above it never
 * resizes between tracks. Long titles therefore have to get *smaller*, not
 * taller — the alternative is what the previous layout did, which was overflow
 * a centred grid item and get clipped at both ends. The thresholds are
 * character counts because that is what the layout actually reacts to, and they
 * are picked so a 90-character title still lands inside two lines at every
 * viewport this screen supports.
 */
export function titleFit(title: string): 'lg' | 'md' | 'sm' | 'xs' {
  const length = title.trim().length;
  if (length <= 20) return 'lg';
  if (length <= 36) return 'md';
  if (length <= 58) return 'sm';
  return 'xs';
}

function translatedValues(values?: Record<string, string | number>): Record<string, string | number> | undefined {
  if (!values) return undefined;
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      typeof value === 'string' && value.startsWith('autoMode.') ? t(value) : value,
    ]),
  );
}

function activityText(activity: AutoActivity): string {
  return t(activity.key, translatedValues(activity.values));
}

export function AutoMode() {
  const current = createMemo(() => state.playback.currentTrack);
  const active = createMemo(() => state.autoMode.active);
  const [chromeVisible, setChromeVisible] = createSignal(true);
  const [agentVisible, setAgentVisible] = createSignal(false);
  const [lyricsOpen, setLyricsOpen] = createSignal(false);
  const [djPickerOpen, setDjPickerOpen] = createSignal(false);
  const [requestOpen, setRequestOpen] = createSignal(false);
  const [mobilePanel, setMobilePanel] = createSignal<AutoMobilePanel>('closed');
  const [mobileLayout, setMobileLayout] = createSignal(
    typeof window !== 'undefined' && window.innerWidth <= 1023,
  );
  const [prompt, setPrompt] = createSignal('');
  const [requestQuery, setRequestQuery] = createSignal('');
  const [requestResults, setRequestResults] = createSignal<CatalogItem[]>([]);
  const [requestBusy, setRequestBusy] = createSignal(false);
  let requestAborter: AbortController | null = null;
  let requestTimer: ReturnType<typeof setTimeout> | null = null;
  let spokenRequestAborter: AbortController | null = null;
  let spokenRequestSeq = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let agentTimer: ReturnType<typeof setTimeout> | null = null;
  let rootEl: HTMLDivElement | undefined;
  let mobileMedia: MediaQueryList | undefined;

  const closeMobilePanel = () => {
    setMobilePanel('closed');
    setDjPickerOpen(false);
    setRequestOpen(false);
  };

  const openMobilePanel = (panel: Exclude<AutoMobilePanel, 'closed'>) => {
    setDjPickerOpen(false);
    setRequestOpen(false);
    setMobilePanel(panel);
    armIdle();
  };

  const syncMobileCoverAnchor = () => {
    if (!rootEl || window.innerWidth > 1023) return;
    const slot = document.querySelector<HTMLElement>('[data-now-playing-cover-slot]');
    if (!slot) return;
    const rect = slot.getBoundingClientRect();
    const surfaceRect = slot.closest<HTMLElement>('[data-player-surface-open]')?.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    // The shared surface may still be completing its vertical entrance when
    // Auto is selected quickly. Store coordinates inside that surface, not its
    // transient viewport translation, so the cover never inherits a +100dvh
    // offset from the opening animation.
    rootEl.style.setProperty('--auto-mobile-cover-left', `${rect.left - (surfaceRect?.left ?? 0)}px`);
    rootEl.style.setProperty('--auto-mobile-cover-top', `${rect.top - (surfaceRect?.top ?? 0)}px`);
    rootEl.style.setProperty('--auto-mobile-cover-width', `${rect.width}px`);
    rootEl.style.setProperty('--auto-mobile-cover-height', `${rect.height}px`);
    rootEl.dataset.mobileCoverAnchored = '';
  };

  const releaseMobileCoverAnchor = () => {
    if (!rootEl) return;
    rootEl.style.removeProperty('--auto-mobile-cover-left');
    rootEl.style.removeProperty('--auto-mobile-cover-top');
    rootEl.style.removeProperty('--auto-mobile-cover-width');
    rootEl.style.removeProperty('--auto-mobile-cover-height');
    delete rootEl.dataset.mobileCoverAnchored;
  };

  const syncMobileLayout = () => {
    const compact = mobileMedia?.matches ?? window.innerWidth <= 1023;
    setMobileLayout(compact);
    if (!compact) closeMobilePanel();
  };

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    setChromeVisible(true);
    if (!active()) return;
    idleTimer = setTimeout(() => setChromeVisible(false), IDLE_MS);
  };

  createEffect(() => {
    if (active()) armIdle();
    else if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (!active()) closeMobilePanel();
  });

  createEffect(() => {
    const track = current();
    // Reset before both sides of the shared-cover handoff. Track-to-track music
    // changes keep Lyrics open, but podcasts can never expose the surface.
    if (!active() || !track || isPodcastTrack(track)) setLyricsOpen(false);
  });

  createEffect(() => {
    current()?.id;
    if (!active()) return;
    armIdle();
  });

  createEffect(() => {
    const activity = state.autoMode.activity;
    if (agentTimer) clearTimeout(agentTimer);
    setAgentVisible(Boolean(activity));
    if (activity && activity.status !== 'working') {
      agentTimer = setTimeout(() => setAgentVisible(false), 6_000);
    }
  });

  onCleanup(() => {
    if (idleTimer) clearTimeout(idleTimer);
    if (agentTimer) clearTimeout(agentTimer);
    if (requestTimer) clearTimeout(requestTimer);
    requestAborter?.abort();
    spokenRequestAborter?.abort();
    mobileMedia?.removeEventListener('change', syncMobileLayout);
    window.removeEventListener('resize', releaseMobileCoverAnchor);
    window.removeEventListener('orientationchange', releaseMobileCoverAnchor);
  });

  onMount(() => {
    if (typeof window.matchMedia === 'function') {
      mobileMedia = window.matchMedia('(max-width: 1023px)');
      mobileMedia.addEventListener('change', syncMobileLayout);
    }
    syncMobileLayout();
    // Match Now Playing only for the handoff itself. Once the viewport changes
    // (rotation, keyboard, split-screen), release those measured coordinates
    // and let Auto's responsive composition own the new geometry. The hidden
    // Now Playing carousel is not a reliable resize reference.
    window.addEventListener('resize', releaseMobileCoverAnchor);
    window.addEventListener('orientationchange', releaseMobileCoverAnchor);
    syncMobileCoverAnchor();
    requestAnimationFrame(syncMobileCoverAnchor);
  });

  const art = createMemo(() => {
    const track = current();
    return track ? track.cover ?? coverUrl(track.id) : '';
  });
  const upcoming = createMemo(() => state.playback.queue.slice(Math.max(0, state.playback.index + 1)));
  const progress = createMemo(() => {
    const duration = state.playback.duration;
    return duration > 0 ? Math.min(100, (state.playback.currentTime / duration) * 100) : 0;
  });
  const backdropStyle = (): JSX.CSSProperties => {
    const url = art();
    return url ? { 'background-image': `url("${url}")` } : {};
  };

  const activeDj = createMemo(() =>
    DJ_PROFILES.find((profile) => profile.id === (state.autoMode.djProfile ?? 'adaptive')) ?? DJ_PROFILES[0],
  );
  const autoRequests = createMemo(() => state.autoMode.requests ?? []);
  const transitionState = createMemo(() => state.autoMode.transition ?? { status: 'idle' as const });

  /** What the booth knows about the track on air, and the one cued behind it. */
  const nowReading = createMemo(() => {
    const track = current();
    return track ? state.autoMode.plan[queueIdentity(track)] : undefined;
  });
  const nextPlan = createMemo(() => {
    const next = state.playback.queue[state.playback.index + 1];
    return next ? state.autoMode.plan[queueIdentity(next)] : undefined;
  });
  /** Time left before a committed blend opens, once it is close enough to be
   * worth watching. A mix you can see coming is the whole appeal of a booth. */
  const cueCountdown = createMemo(() => {
    const at = state.autoMode.transition.at;
    if (transitionState().status !== 'armed' || !at) return '';
    const left = at - state.playback.currentTime;
    return left > 0 && left < 100 ? clockTime(left) : '';
  });

  /**
   * Turn a spoken name into something the booth can actually cue.
   *
   * An artist first — "pon oliver heldens" means the act, and one of their own
   * tracks is the way in. Failing that a track, because "pon despacito" is the
   * same verbal act aimed at a song. The catalogue decides whether the words
   * name anything; the parser only decides that they were meant to.
   */
  const resolveSpokenRequest = async (
    name: string,
    signal: AbortSignal,
  ): Promise<{ track: Track; artist: string } | null> => {
    const requested = new Set(autoRequests().flatMap((request) => (
      request.track ? [`${request.track.artist}|${request.track.title}`.toLowerCase()] : []
    )));
    const pickable = (items: CatalogItem[]) =>
      items.find((item) => item.type !== 'artist' && item.type !== 'album' && item.type !== 'playlist'
        && !requested.has(`${item.artist ?? item.subtitle ?? ''}|${item.title}`.toLowerCase()));

    const profile = await api.getArtistProfile(name, undefined, signal).catch(() => null);
    const fromArtist = profile?.resolved ? pickable(profile.top_tracks ?? []) : undefined;
    const item = fromArtist
      ?? pickable((await api.searchCatalog(name, signal, 'track').catch(() => null))?.items ?? []);
    if (!item) return null;

    const artist = item.artist ?? item.subtitle ?? profile?.name ?? name;
    const local = item.track_id ? state.library.find((track) => track.id === item.track_id) : null;
    if (local) return { track: local, artist };
    const resolved = await api.resolveCatalogItem(
      { artist, title: item.title, duration: item.duration },
      signal,
    )
      .catch(() => null);
    if (!resolved?.video_id) return null;
    return {
      track: {
        id: resolved.video_id,
        title: item.title,
        artist,
        album: item.album,
        duration: item.duration,
        cover: item.cover,
        source: 'preview',
      },
      artist,
    };
  };

  const submitDirection = async () => {
    const value = prompt().trim();
    if (!value) return;
    setPrompt('');
    armIdle();
    const current = state.autoMode.direction ?? {
      energy: 0, familiarity: 0, prompt: '', include: [], exclude: [],
    };
    const clientRequest = parseNamedRequest(value);
    if (!clientRequest) {
      spokenRequestAborter?.abort();
      spokenRequestSeq += 1;
      actions.setAutoDirection(
        parseDjDirection(value, current),
        t('autoMode.note.quoted', { text: value }),
      );
      return;
    }
    spokenRequestAborter?.abort();
    const aborter = new AbortController();
    spokenRequestAborter = aborter;
    const sequence = ++spokenRequestSeq;
    actions.reportAutoActivity('autoMode.agent.looking', 'working', { name: clientRequest });
    let command: Awaited<ReturnType<typeof api.interpretDjCommand>> | null = null;
    if (typeof api.interpretDjCommand === 'function') {
      try {
        command = await api.interpretDjCommand(value, aborter.signal);
      } catch {
        command = null;
      }
    }
    if (aborter.signal.aborted || sequence !== spokenRequestSeq) return;
    const patch = command?.direction_patch ?? parseDjDirection(value, current);
    const fallbackRequest = clientRequest;
    const target = command?.request ?? (fallbackRequest
      ? { kind: 'query' as const, label: fallbackRequest, query: fallbackRequest }
      : null);
    if (!target) {
      actions.setAutoDirection(
        patch,
        t('autoMode.note.quoted', { text: value }),
      );
      spokenRequestAborter = null;
      return;
    }
    if (target.kind === 'artist') {
      actions.setAutoDirection(
        { ...patch, prompt: value, include: [target.artist.name] },
        t('autoMode.note.added', { title: target.artist.name }),
      );
      actions.requestAutoArtist(target.artist.name);
      spokenRequestAborter = null;
      return;
    }
    const spoken = target.query || parseNamedRequest(value) || value;
    const found = await resolveSpokenRequest(spoken, aborter.signal);
    if (aborter.signal.aborted || sequence !== spokenRequestSeq) return;
    spokenRequestAborter = null;
    if (!found) {
      // Say so. The phrase still carries a direction, so apply that much rather
      // than pretending the whole instruction landed.
      actions.reportAutoActivity('autoMode.agent.noMatch', 'error', { name: spoken });
      const steered = patch;
      if (steered.energy !== current.energy || steered.familiarity !== current.familiarity) {
        actions.setAutoDirection(steered, t('autoMode.note.quoted', { text: value }));
      }
      return;
    }
    // Lean the runway their way too, so the set keeps that colour once the
    // requested track has played.
    actions.setAutoDirection(
      { ...patch, prompt: value, include: [found.artist] },
      t('autoMode.note.added', { title: found.track.title }),
    );
    actions.requestAutoTrack(found.track);
  };

  const setDirectionLevel = (key: 'energy' | 'familiarity', value: number, note: string) => {
    actions.setAutoDirection({ [key]: value, prompt: '' }, note);
    armIdle();
  };

  const searchRequests = (value: string) => {
    setRequestQuery(value);
    if (requestTimer) clearTimeout(requestTimer);
    requestAborter?.abort();
    if (value.trim().length < 2) {
      setRequestResults([]);
      return;
    }
    requestTimer = setTimeout(() => {
      const aborter = new AbortController();
      requestAborter = aborter;
      setRequestBusy(true);
      void api.searchCatalog(value.trim(), aborter.signal, 'track')
        .then((result) => setRequestResults(result.items.filter((item) => item.type !== 'artist').slice(0, 12)))
        .catch(() => {
          if (!aborter.signal.aborted) setRequestResults([]);
        })
        .finally(() => {
          if (requestAborter === aborter) setRequestBusy(false);
        });
    }, 220);
  };

  const requestItem = async (item: CatalogItem) => {
    setRequestBusy(true);
    try {
      const local = item.track_id ? state.library.find((track) => track.id === item.track_id) : null;
      let track: Track | null = local ?? null;
      if (!track) {
        const resolved = await api.resolveCatalogItem({
          artist: item.artist ?? item.subtitle ?? '',
          title: item.title,
          duration: item.duration,
        });
        if (!resolved.video_id) throw new Error('unresolved');
        track = {
          id: resolved.video_id,
          title: item.title,
          artist: item.artist ?? item.subtitle ?? '',
          album: item.album,
          duration: item.duration,
          cover: item.cover,
          source: 'preview',
        };
      }
      actions.requestAutoTrack(track);
      setRequestOpen(false);
      setRequestQuery('');
      setRequestResults([]);
    } finally {
      setRequestBusy(false);
    }
  };

  /**
   * Auto Mode's keyboard shortcuts.
   *
   * Keydown is delegated, so everything typed into the command bar or the
   * request search reaches this handler too. Without the guard below, writing a
   * message to the DJ skipped a track on every "n" and rode the volume with the
   * arrow keys — the surface fought whoever tried to talk to it.
   */
  const onKeyDown = (event: KeyboardEvent) => {
    armIdle();
    if (event.key === 'Escape') {
      if (requestOpen()) {
        setRequestOpen(false);
        return;
      }
      if (djPickerOpen()) {
        setDjPickerOpen(false);
        return;
      }
      if (mobilePanel() !== 'closed') {
        closeMobilePanel();
        return;
      }
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
    if (event.key === 'ArrowUp') actions.setVolume(state.playback.volume + 0.05);
    else if (event.key === 'ArrowDown') actions.setVolume(state.playback.volume - 0.05);
    else if (event.key.toLowerCase() === 'n') void actions.autoSkip();
  };

  return (
    <div
      ref={rootEl}
      classList={{ [styles.root]: true, [styles.active]: active(), [styles.ambient]: !chromeVisible() }}
      role="region"
      aria-label={t('autoMode.aria')}
      data-playing={state.playback.isPlaying ? 'true' : 'false'}
      data-mobile-panel={mobilePanel()}
      tabIndex={-1}
      onPointerMove={armIdle}
      onKeyDown={onKeyDown}
    >
      <div class={styles.embeddedTools} data-no-surface-swipe="">
        <button
          class={styles.profile}
          type="button"
          aria-label={t('autoMode.dj.changeCurrent', { dj: t(activeDj().titleKey) })}
          aria-expanded={djPickerOpen()}
          onClick={() => {
            setDjPickerOpen((open) => !open);
            armIdle();
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <circle cx="12" cy="12" r="8" /><path d="m15.5 8.5-2.1 4.9-4.9 2.1 2.1-4.9z" />
          </svg>
          <span class={styles.profileText}>
            <small>{t('autoMode.dj.label')}</small>
            <strong>{t(activeDj().titleKey)}</strong>
          </span>
          <span class={styles.profileChange}>{t('autoMode.dj.change')}</span>
        </button>
      </div>

        <Show when={djPickerOpen()}>
          <div class={styles.djPicker} role="dialog" aria-label={t('autoMode.dj.choose')}>
            <div class={styles.djPickerHead}>
              <strong>{t('autoMode.dj.choose')}</strong>
              <span>{t('autoMode.dj.chooseHint')}</span>
            </div>
            <div class={styles.djPickerGrid} role="listbox" aria-label={t('autoMode.dj.choose')}>
              <For each={DJ_PROFILES}>
                {(profile) => (
                  <button
                    type="button"
                    classList={{ [styles.djCard]: true, [styles.djCardActive]: profile.id === (state.autoMode.djProfile ?? 'adaptive') }}
                    role="option"
                    aria-selected={profile.id === (state.autoMode.djProfile ?? 'adaptive')}
                    onClick={() => {
                      actions.setAutoDjProfile(profile.id);
                      setDjPickerOpen(false);
                    }}
                  >
                    <strong>{t(profile.titleKey)}</strong>
                    <span>{t(profile.traitKey)}</span>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={!current()}>
          <div class={styles.emptyDj} role="status">
            <span class={styles.emptyDisc} aria-hidden="true" />
            <strong>{t('autoMode.booth.opening')}</strong>
            <span>{t('autoMode.booth.openingHint')}</span>
          </div>
        </Show>

        <Show when={current()}>
          <div class={styles.stage}>
            <div class={styles.coverStage}>
              <div
                class={styles.coverFrame}
                data-auto-cover-slot=""
                data-lyrics-open={lyricsOpen() ? '' : undefined}
                inert={mobilePanel() !== 'closed' ? true : undefined}
              >
                <div class={styles.coverGlow} style={backdropStyle()} aria-hidden="true" />
                <div class={styles.cover} style={backdropStyle()} role="img" aria-label={current()!.title} />
                <Show when={lyricsOpen()}>
                  <div class={styles.lyricsSurface}>
                    <LyricsPanel />
                  </div>
                </Show>
                {/* Mobile only, by CSS: the panel's metadata block is still the
                    live region, so this is a second rendering of text that is
                    already announced. */}
                <div class={styles.coverCaption} data-fit={titleFit(current()!.title)} aria-hidden="true">
                  <p class={styles.capTitle}>{current()!.title}</p>
                  <p class={styles.capArtist}>{current()!.artist}</p>
                </div>
                <Show when={!isPodcastTrack(current()!)}>
                  <button
                    classList={{ [styles.lyricsToggle]: true, [styles.lyricsToggleOn]: lyricsOpen() }}
                    type="button"
                    aria-label={lyricsOpen() ? t('nowPlaying.showCover') : t('nowPlaying.showLyrics')}
                    aria-pressed={lyricsOpen()}
                    onClick={() => {
                      setLyricsOpen((open) => !open);
                      armIdle();
                    }}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                      <path d="M5 6h14M5 10h10M5 14h14M5 18h8" />
                    </svg>
                  </button>
                </Show>
              </div>
            </div>

            <div class={styles.panel}>
              <div class={styles.meta} data-fit={titleFit(current()!.title)} aria-live="polite">
                <div class={styles.titleBox}>
                  <h1 class={styles.title} title={current()!.title}>{current()!.title}</h1>
                </div>
                <p class={styles.artist} title={current()!.artist}>{current()!.artist}</p>
              </div>

              <div class={styles.status}>
                <Show when={state.autoMode.activity && agentVisible()}>
                  <div
                    class={styles.agent}
                    data-status={state.autoMode.activity!.status}
                    role="status"
                    aria-live="polite"
                  >
                    <span class={styles.agentPulse} aria-hidden="true" />
                    <span class={styles.agentText}>{activityText(state.autoMode.activity!)}</span>
                  </div>
                </Show>
              </div>

              <section
                class={styles.booth}
                aria-label={t('autoMode.booth.aria')}
                role={mobilePanel() === 'booth' ? 'dialog' : undefined}
                aria-modal={mobilePanel() === 'booth' ? 'true' : undefined}
                data-auto-mobile-sheet="booth"
              >
                <Show when={mobileLayout()}>
                  <div class={styles.mobileSheetHead}>
                    <div>
                      <small>{t('autoMode.label')}</small>
                      <strong>{t('autoMode.mobile.booth')}</strong>
                    </div>
                    <button type="button" aria-label={t('common.close')} onClick={closeMobilePanel}>×</button>
                  </div>

                  <button
                    class={styles.mobileDjProfile}
                    type="button"
                    aria-label={t('autoMode.dj.changeCurrent', { dj: t(activeDj().titleKey) })}
                    aria-expanded={djPickerOpen()}
                    onClick={() => setDjPickerOpen((open) => !open)}
                  >
                    <span>
                      <small>{t('autoMode.dj.label')}</small>
                      <strong>{t(activeDj().titleKey)}</strong>
                    </span>
                    <b>{t('autoMode.dj.change')}</b>
                  </button>
                </Show>

                {/* The decks, in the booth's own units. Everything here is
                    measured — an unread track shows a dash, never a guess. */}
                <div class={styles.readout}>
                  <span class={styles.deck}>
                    <small>{t('autoMode.booth.now')}</small>
                    <b>{bpmText(nowReading()?.bpm)}</b>
                    <span class={styles.unit}>{t('autoMode.booth.bpm')}</span>
                    <Show when={nowReading()?.key}><i>{nowReading()!.key}</i></Show>
                  </span>
                  <span class={styles.blend} data-live={transitionState().status !== 'idle' ? '' : undefined}>
                    <Show when={transitionState().status !== 'idle'} fallback={<span aria-hidden="true">→</span>}>
                      <span class={styles.blendMark} aria-hidden="true" />
                    </Show>
                    <span>
                      {techniqueText(nextPlan()?.transition?.technique ?? transitionState().technique)}
                      <Show when={cueCountdown()}>{' '}{t('autoMode.booth.in', { time: cueCountdown()! })}</Show>
                    </span>
                  </span>
                  <span class={styles.deck}>
                    <small>{t('autoMode.booth.next')}</small>
                    <b>{bpmText(nextPlan()?.bpm)}</b>
                    <span class={styles.unit}>{t('autoMode.booth.bpm')}</span>
                    <Show when={nextPlan()?.key}><i>{nextPlan()!.key}</i></Show>
                  </span>
                  <button class={styles.requestButton} type="button" onClick={() => setRequestOpen(true)}>
                    {t('autoMode.dj.request')}
                    <small>{t('autoMode.dj.requestEta')}</small>
                  </button>
                </div>

                {/* Talkback: you speak to the booth in your own words, and it
                    repeats back what it heard in the status line. */}
                <form
                  class={styles.talkback}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitDirection();
                  }}
                >
                  <span class={styles.caret} aria-hidden="true">›</span>
                  <input
                    value={prompt()}
                    onInput={(event) => setPrompt(event.currentTarget.value)}
                    placeholder={t('autoMode.dj.commandPlaceholder')}
                    aria-label={t('autoMode.dj.commandAria')}
                  />
                  <button type="submit" disabled={!prompt().trim()}>{t('autoMode.dj.send')}</button>
                </form>

                <div class={styles.switches}>
                  <DirectionSwitch
                    label={t('autoMode.booth.energy')}
                    options={[t('autoMode.booth.energyDown'), t('autoMode.booth.hold'), t('autoMode.booth.energyUp')]}
                    notes={[t('autoMode.note.energy.down'), t('autoMode.note.energy.hold'), t('autoMode.note.energy.up')]}
                    value={state.autoMode.direction?.energy ?? 0}
                    onPick={(value, note) => setDirectionLevel('energy', value, note)}
                  />
                  <DirectionSwitch
                    label={t('autoMode.booth.crate')}
                    options={[t('autoMode.booth.crateDeep'), t('autoMode.booth.hold'), t('autoMode.booth.crateKnown')]}
                    notes={[t('autoMode.note.crate.deep'), t('autoMode.note.crate.hold'), t('autoMode.note.crate.known')]}
                    value={state.autoMode.direction?.familiarity ?? 0}
                    onPick={(value, note) => setDirectionLevel('familiarity', value, note)}
                  />
                </div>

                {/* Honest about when an instruction lands: the track playing and
                    any handoff already cued behind it are not rewritten. */}
                <p class={styles.boothFoot} aria-live="polite">
                  {state.autoMode.pendingDirection || transitionState().status !== 'idle'
                    ? t('autoMode.dj.appliesNext')
                    : t('autoMode.dj.directionHint')}
                </p>

                <Show when={autoRequests().length > 0}>
                  <div class={styles.requests} aria-label={t('autoMode.dj.requests')}>
                    <span class={styles.requestsLabel}>{t('autoMode.dj.requests')}</span>
                    <For each={autoRequests()}>
                      {(request) => (
                        <span class={styles.requestChip}>
                          <span>{request.label}</span>
                          <Show when={request.etaTracks}>
                            <em>{t('autoMode.dj.withinTracks', { count: request.etaTracks! })}</em>
                          </Show>
                          <Show when={request.status === 'failed'}>
                            <em>{t('autoMode.dj.requestUnavailable')}</em>
                          </Show>
                          <button
                            type="button"
                            aria-label={t('autoMode.dj.cancelRequest', { title: request.label })}
                            onClick={() => actions.cancelAutoRequest(request.id)}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
                              <path d="M6 6l12 12M18 6 6 18" />
                            </svg>
                          </button>
                        </span>
                      )}
                    </For>
                  </div>
                </Show>
              </section>

              <div class={styles.controls} inert={mobilePanel() !== 'closed' ? true : undefined}>
                <div class={styles.seek}>
                  <span class={styles.time}>{clockTime(state.playback.currentTime)}</span>
                  <div class={styles.progress}>
                    <div class={styles.progressFill} style={{ width: `${progress()}%` }} />
                  </div>
                  <span class={styles.time}>{clockTime(state.playback.duration)}</span>
                </div>
                <div class={styles.transport}>
                  <div class={styles.cluster}>
                    <button type="button" aria-label={t('common.prev')} onClick={() => actions.prev()}>
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 6h2v12H6zm3.5 6 8.5 6V6z" /></svg>
                    </button>
                    <button class={styles.play} type="button" aria-label={state.playback.isPlaying ? t('common.pause') : t('common.play')} onClick={() => actions.togglePlay()}>
                      <Show when={state.playback.isPlaying} fallback={<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z" /></svg>}>
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
                      </Show>
                    </button>
                    <button type="button" aria-label={t('common.next')} onClick={() => void actions.autoSkip()}>
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16 6h2v12h-2zm-1.5 6L6 6v12z" /></svg>
                    </button>
                  </div>
                  <div class={styles.extras}>
                    {/* Having a song and marking it out are separate acts, in
                      * that order: the heart appears once the song is yours,
                      * and the slot beside it is what makes it yours. */}
                    <Show when={isSavedTrack(current()!)}>
                      <FavouriteButton
                        favourite={savedFromTrack(current()!)}
                        class={styles.secondaryAction}
                      />
                    </Show>
                    <CollectionButton
                      entry={savedFromTrack(current()!)}
                      class={styles.secondaryAction}
                      hideOwned
                    />
                  </div>
                </div>
              </div>

              <Show when={mobileLayout()}>
                <nav class={styles.mobileDock} aria-label={t('autoMode.mobile.controls')} data-no-surface-swipe="">
                <button
                  type="button"
                  aria-expanded={mobilePanel() === 'booth'}
                  onClick={() => openMobilePanel('booth')}
                >
                  <span class={styles.mobileDockMark} aria-hidden="true"><i /><i /><i /></span>
                  <span>
                    <small>{t('autoMode.mobile.booth')}</small>
                    <strong>{t(activeDj().titleKey)}</strong>
                  </span>
                </button>
                <button
                  type="button"
                  aria-expanded={mobilePanel() === 'route'}
                  onClick={() => openMobilePanel('route')}
                >
                  <span
                    class={styles.mobileRouteCover}
                    style={{ 'background-image': upcoming()[0] ? `url("${upcoming()[0].cover ?? coverUrl(upcoming()[0].id)}")` : undefined }}
                    aria-hidden="true"
                  />
                  <span>
                    <small>{t('autoMode.mobile.route')}</small>
                    <strong>
                      {upcoming()[0]?.title ?? t('autoMode.mobile.routeEmpty')}
                      <Show when={upcoming().length > 1}> · +{upcoming().length - 1}</Show>
                    </strong>
                  </span>
                </button>
                </nav>
              </Show>
            </div>
          </div>

          <Show when={upcoming().length > 0}>
            <section
              class={styles.upStrip}
              aria-label={t('autoMode.upNext')}
              role={mobilePanel() === 'route' ? 'dialog' : undefined}
              aria-modal={mobilePanel() === 'route' ? 'true' : undefined}
              data-auto-mobile-sheet="route"
            >
              <Show when={mobileLayout()}>
                <div class={styles.mobileSheetHead}>
                  <div>
                    <small>{t('autoMode.label')}</small>
                    <strong>{t('autoMode.mobile.route')}</strong>
                  </div>
                  <button type="button" aria-label={t('common.close')} onClick={closeMobilePanel}>×</button>
                </div>
              </Show>
              <span class={styles.upHead}>
                {transitionState().status === 'idle'
                  ? t('autoMode.dj.route')
                  : `${transitionState().status === 'armed' ? t('autoMode.dj.cued') : t('autoMode.dj.mixing')} · ${techniqueText(transitionState().technique)}`}
              </span>
              <div
                class={styles.filmstrip}
                data-rail=""
                tabIndex={0}
                onWheel={(event) => {
                  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
                  event.currentTarget.scrollLeft += event.deltaY;
                  event.preventDefault();
                }}
              >
                <For each={upcoming().slice(0, 3)}>
                  {(track, index) => {
                    const image = () => track.cover ?? coverUrl(track.id);
                    const plan = () => state.autoMode.plan[queueIdentity(track)];
                    /** The one entry the DJ has already loaded and cued. */
                    const cued = () =>
                      index() === 0 && transitionState().status !== 'idle'
                      && transitionState().nextTrackId === queueIdentity(track);
                    const tap = createResponsiveTap({
                      disabled: cued,
                      onTap: () => actions.promoteInAutoRoute(track.queueId),
                    });
                    return (
                      <button
                        classList={{ [styles.nextCard]: true, [styles.nextCardCued]: cued() }}
                        type="button"
                        title={`${track.title} — ${track.artist}`}
                        aria-label={cued()
                          ? `${track.title} — ${track.artist}`
                          : t('autoMode.dj.promote', { title: track.title })}
                        disabled={cued()}
                        data-pressable
                        {...tap}
                      >
                        <span class={styles.nextCover} style={{ 'background-image': `url("${image()}")` }} />
                        <span class={styles.nextMeta}>
                          <small class={styles.routePosition}>
                            {cued() ? t('autoMode.dj.cued') : index() + 1}
                            <Show when={plan()?.requestId}> · {t('autoMode.dj.requested')}</Show>
                          </small>
                          <strong>{track.title}</strong>
                          <span>{track.artist}</span>
                          <Show when={plan()?.transition}>
                            <small>{techniqueText(plan()!.transition!.technique)} · {plan()?.bpm ? `${Math.round(plan()!.bpm!)} BPM` : t('autoMode.dj.analysing')}</small>
                          </Show>
                        </span>
                      </button>
                    );
                  }}
                </For>
              </div>
            </section>
          </Show>
          <Show when={mobileLayout() && mobilePanel() === 'route' && upcoming().length === 0}>
            <section
              classList={{ [styles.upStrip]: true, [styles.routeEmptyPanel]: true }}
              aria-label={t('autoMode.upNext')}
              role="dialog"
              aria-modal="true"
              data-auto-mobile-sheet="route"
            >
              <div class={styles.mobileSheetHead}>
                <div>
                  <small>{t('autoMode.label')}</small>
                  <strong>{t('autoMode.mobile.route')}</strong>
                </div>
                <button type="button" aria-label={t('common.close')} onClick={closeMobilePanel}>×</button>
              </div>
              <p>{t('autoMode.mobile.routeEmpty')}</p>
            </section>
          </Show>
        </Show>

        <Show when={mobileLayout() && mobilePanel() !== 'closed'}>
          <button
            class={styles.mobileSheetBackdrop}
            type="button"
            aria-label={t('autoMode.mobile.closePanel')}
            onClick={closeMobilePanel}
          />
        </Show>

        <Show when={requestOpen()}>
          <aside class={styles.requestPanel} aria-label={t('autoMode.dj.requestPanelAria')}>
            <div class={styles.requestHead}>
              <div>
                <strong>{t('autoMode.dj.request')}</strong>
                <span>{t('autoMode.dj.requestPromise')}</span>
              </div>
              <button type="button" aria-label={t('common.close')} onClick={() => setRequestOpen(false)}>×</button>
            </div>
            <input
              class={styles.requestSearch}
              autofocus
              value={requestQuery()}
              onInput={(event) => searchRequests(event.currentTarget.value)}
              placeholder={t('autoMode.dj.searchPlaceholder')}
              aria-label={t('autoMode.dj.searchPlaceholder')}
            />
            <div class={styles.requestResults}>
              <Show when={!requestBusy()} fallback={<p class={styles.requestEmpty}>{t('autoMode.dj.searching')}</p>}>
                <For each={requestResults()} fallback={<p class={styles.requestEmpty}>{t('autoMode.dj.searchEmpty')}</p>}>
                  {(item) => {
                    const tap = createResponsiveTap({ onTap: () => void requestItem(item) });
                    return (
                      <button type="button" data-pressable {...tap}>
                        <span class={styles.resultCover} style={{ 'background-image': item.cover ? `url("${item.cover}")` : undefined }} />
                        <span><strong>{item.title}</strong><small>{item.artist ?? item.subtitle}</small></span>
                        <b>{t('autoMode.dj.requestAction')}</b>
                      </button>
                    );
                  }}
                </For>
              </Show>
            </div>
          </aside>
        </Show>
    </div>
  );
}
