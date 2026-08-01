import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  type JSX,
} from 'solid-js';
import { actions, state } from '../stores';
import { api, type DjProfile } from '../lib/api';
import {
  AUTO_MODE_LAYOUT_KEY,
  AUTO_MODE_PANELS,
  cloneAutoModeLayout,
  DEFAULT_AUTO_MODE_LAYOUT,
  parseAutoModeLayout,
  type AutoModeDesktopLayout,
  type AutoModePanelId,
} from '../lib/autoModeLayout';
import { parseDjDirection, parseNamedRequest } from '../lib/djDirection';
import type { AutoActivity } from '../lib/generatedQueue';
import { queueIdentity } from '../lib/queueDiscovery';
import { coverUrl } from '../lib/media';
import { isPodcastTrack } from '../lib/track';
import { t } from '../lib/i18n';
import type { CatalogItem, Track } from '../types/music';
import { NowPlayingBrowser } from './NowPlayingBrowser';
import { PlayerStage } from './PlayerStage';
import { PlayerTrackList, type PlayerTrackListEntry } from './PlayerTrackList';
import { PlayerWorkspace } from './PlayerWorkspace';
import styles from './AutoMode.module.css';

const IDLE_MS = 12_000;
const DIRECTION_LEVELS = [-0.65, 0, 0.65] as const;
const AUTO_MINIMUMS = { booth: 250, stage: 390, route: 260 };

const DJ_PROFILES: Array<{ id: DjProfile; titleKey: string; traitKey: string }> = [
  { id: 'adaptive', titleKey: 'autoMode.dj.adaptive', traitKey: 'autoMode.dj.adaptiveTrait' },
  { id: 'long_blend', titleKey: 'autoMode.dj.longBlend', traitKey: 'autoMode.dj.longBlendTrait' },
  { id: 'cuts_drops', titleKey: 'autoMode.dj.cutsDrops', traitKey: 'autoMode.dj.cutsDropsTrait' },
  { id: 'open_format', titleKey: 'autoMode.dj.openFormat', traitKey: 'autoMode.dj.openFormatTrait' },
];

function directionIndex(value: number): 0 | 1 | 2 {
  if (value < -0.25) return 0;
  if (value > 0.25) return 2;
  return 1;
}

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

function translatedValues(values?: Record<string, string | number>): Record<string, string | number> | undefined {
  if (!values) return undefined;
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key,
    typeof value === 'string' && value.startsWith('autoMode.') ? t(value) : value,
  ]));
}

function activityText(activity: AutoActivity): string {
  return t(activity.key, translatedValues(activity.values));
}

function techniqueText(technique?: string): string {
  if (!technique) return t('autoMode.dj.analysing');
  const key = `autoMode.dj.technique.${technique}`;
  const translated = t(key);
  return translated === key ? technique.replaceAll('_', ' ') : translated;
}

function readLayout(): AutoModeDesktopLayout {
  try {
    return parseAutoModeLayout(localStorage.getItem(AUTO_MODE_LAYOUT_KEY));
  } catch {
    return cloneAutoModeLayout();
  }
}

function readStageOnly(): boolean {
  try {
    const raw = localStorage.getItem(AUTO_MODE_LAYOUT_KEY);
    return raw ? Boolean((JSON.parse(raw) as { stageOnly?: boolean }).stageOnly) : false;
  } catch {
    return false;
  }
}

export function AutoMode(props: {
  panel: AutoModePanelId;
  onPanelChange: (panel: AutoModePanelId) => void;
  onCarouselProgress?: (index: number, live: boolean) => void;
  surfaceOpen: boolean;
}) {
  const current = createMemo(() => state.playback.currentTrack);
  const upcoming = createMemo(() => state.playback.queue.slice(Math.max(0, state.playback.index + 1)));
  const requests = createMemo(() => state.autoMode.requests ?? []);
  const transition = createMemo(() => state.autoMode.transition ?? { status: 'idle' as const });
  const activeDj = createMemo(() =>
    DJ_PROFILES.find((profile) => profile.id === (state.autoMode.djProfile ?? 'adaptive')) ?? DJ_PROFILES[0],
  );
  const [layout, setLayout] = createSignal(readLayout());
  const [stageOnly, setStageOnly] = createSignal(readStageOnly());
  const [resting, setResting] = createSignal(false);
  const [profileOpen, setProfileOpen] = createSignal(false);
  const [boothView, setBoothView] = createSignal<'controls' | 'request'>('controls');
  const [prompt, setPrompt] = createSignal('');
  const [activityVisible, setActivityVisible] = createSignal(Boolean(state.autoMode.activity));
  let idleTimer: number | undefined;
  let activityTimer: number | undefined;
  let spokenRequestAborter: AbortController | null = null;
  let spokenRequestSequence = 0;

  const persistLayout = (nextLayout = layout(), nextStageOnly = stageOnly()) => {
    try {
      localStorage.setItem(AUTO_MODE_LAYOUT_KEY, JSON.stringify({ ...nextLayout, stageOnly: nextStageOnly }));
    } catch {
      /* storage disabled/full */
    }
  };

  const updateLayout = (next: AutoModeDesktopLayout) => {
    setLayout(next);
    persistLayout(next);
  };

  const toggleStageOnly = () => {
    const next = !stageOnly();
    setStageOnly(next);
    persistLayout(layout(), next);
    if (next) props.onPanelChange('stage');
  };

  const armIdle = () => {
    window.clearTimeout(idleTimer);
    setResting(false);
    if (!state.autoMode.active || !state.playback.isPlaying) return;
    idleTimer = window.setTimeout(() => setResting(true), IDLE_MS);
  };

  createEffect(() => {
    props.panel;
    setProfileOpen(false);
    if (props.panel !== 'booth') setBoothView('controls');
  });

  createEffect(() => {
    state.playback.currentTrack?.id;
    state.playback.isPlaying;
    armIdle();
  });

  createEffect(() => {
    const activity = state.autoMode.activity;
    window.clearTimeout(activityTimer);
    setActivityVisible(Boolean(activity));
    if (activity && activity.status !== 'working') {
      activityTimer = window.setTimeout(() => setActivityVisible(false), 6_000);
    }
  });

  onCleanup(() => {
    window.clearTimeout(idleTimer);
    window.clearTimeout(activityTimer);
    spokenRequestAborter?.abort();
  });

  const resolveSpokenRequest = async (
    name: string,
    signal: AbortSignal,
  ): Promise<{ track: Track; artist: string } | null> => {
    const requested = new Set(requests().flatMap((request) => (
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
    ).catch(() => null);
    if (!resolved?.video_id) return null;
    return {
      artist,
      track: {
        id: resolved.video_id,
        title: item.title,
        artist,
        album: item.album,
        duration: item.duration,
        cover: item.cover,
        source: 'preview',
      },
    };
  };

  const submitDirection = async () => {
    const value = prompt().trim();
    if (!value) return;
    setPrompt('');
    armIdle();
    const currentDirection = state.autoMode.direction ?? {
      energy: 0, familiarity: 0, prompt: '', include: [], exclude: [],
    };
    const named = parseNamedRequest(value);
    if (!named) {
      actions.setAutoDirection(parseDjDirection(value, currentDirection), t('autoMode.note.quoted', { text: value }));
      return;
    }
    spokenRequestAborter?.abort();
    const aborter = new AbortController();
    spokenRequestAborter = aborter;
    const sequence = ++spokenRequestSequence;
    actions.reportAutoActivity('autoMode.agent.looking', 'working', { name: named });
    const command = typeof api.interpretDjCommand === 'function'
      ? await api.interpretDjCommand(value, aborter.signal).catch(() => null)
      : null;
    if (aborter.signal.aborted || sequence !== spokenRequestSequence) return;
    const patch = command?.direction_patch ?? parseDjDirection(value, currentDirection);
    const target = command?.request ?? { kind: 'query' as const, label: named, query: named };
    if (target.kind === 'artist') {
      actions.setAutoDirection(
        { ...patch, prompt: value, include: [target.artist.name] },
        t('autoMode.note.added', { title: target.artist.name }),
      );
      actions.requestAutoArtist(target.artist.name);
      return;
    }
    const query = target.query || named;
    const found = await resolveSpokenRequest(query, aborter.signal);
    if (aborter.signal.aborted || sequence !== spokenRequestSequence) return;
    spokenRequestAborter = null;
    if (!found) {
      actions.reportAutoActivity('autoMode.agent.noMatch', 'error', { name: query });
      if (patch.energy !== currentDirection.energy || patch.familiarity !== currentDirection.familiarity) {
        actions.setAutoDirection(patch, t('autoMode.note.quoted', { text: value }));
      }
      return;
    }
    actions.setAutoDirection(
      { ...patch, prompt: value, include: [found.artist] },
      t('autoMode.note.added', { title: found.track.title }),
    );
    actions.requestAutoTrack(found.track);
  };

  const setDirection = (key: 'energy' | 'familiarity', value: number, note: string) => {
    actions.setAutoDirection({ [key]: value, prompt: '' }, note);
    armIdle();
  };

  const nextMix = createMemo(() => {
    const next = upcoming()[0];
    if (!next) return t('autoMode.mobile.routeEmpty');
    const plan = state.autoMode.plan[queueIdentity(next)];
    const details = [
      techniqueText(plan?.transition?.technique),
      plan?.bpm ? `${Math.round(plan.bpm)} BPM` : null,
      plan?.key ?? null,
    ].filter(Boolean).join(' · ');
    return `${next.title} — ${details}`;
  });

  const routeEntries = createMemo<PlayerTrackListEntry[]>(() =>
    upcoming().map((track, index) => {
      const plan = state.autoMode.plan[queueIdentity(track)];
      const committed = index === 0
        && transition().status !== 'idle'
        && (!transition().nextTrackId || transition().nextTrackId === track.id);
      const annotation = [
        plan ? t(plan.reasonKey, translatedValues(plan.reasonValues)) : t('autoMode.dj.preparing'),
        plan?.transition ? techniqueText(plan.transition.technique) : null,
        plan?.bpm ? `${Math.round(plan.bpm)} BPM` : null,
        plan?.key ?? null,
      ].filter(Boolean).join(' · ');
      return {
        id: track.queueId,
        title: track.title,
        artist: track.artist,
        cover: track.cover ?? coverUrl(track.id),
        position: index + 1,
        locked: committed,
        annotation,
        badge: committed
          ? t('autoMode.dj.cued')
          : plan?.requestId
            ? t('autoMode.dj.requested')
            : undefined,
        onActivate: committed ? undefined : () => actions.promoteInAutoRoute(track.queueId),
        trailing: committed ? undefined : (
          <button
            class={styles.promote}
            type="button"
            aria-label={t('autoMode.dj.promote', { title: track.title })}
            onClick={() => actions.promoteInAutoRoute(track.queueId)}
          >
            ↑
          </button>
        ),
      };
    }),
  );

  const Booth = (boothProps: { dragHandle: JSX.Element }) => (
    <section class={styles.booth} aria-label={t('autoMode.booth.aria')}>
      <Show
        when={boothView() === 'controls'}
        fallback={
          <NowPlayingBrowser
            purpose="auto-request"
            dragHandle={boothProps.dragHandle}
            onClose={() => setBoothView('controls')}
            onRequested={() => setBoothView('controls')}
          />
        }
      >
        <header class={styles.boothHeader}>
          {boothProps.dragHandle}
          <span>
            <small>{t('autoMode.label')}</small>
            <strong>{t('autoMode.mobile.booth')}</strong>
          </span>
        </header>

        <Show when={current() && !isPodcastTrack(current()!)} fallback={
          <div class={styles.boothEmpty}>
            <strong>{t('autoMode.booth.opening')}</strong>
            <span>{t('autoMode.booth.openingHint')}</span>
          </div>
        }>
          <div class={styles.boothScroll}>
            <div class={styles.dj}>
              <button
                class={styles.djCurrent}
                type="button"
                aria-expanded={profileOpen()}
                aria-label={t('autoMode.dj.changeCurrent', { dj: t(activeDj().titleKey) })}
                onClick={() => setProfileOpen((open) => !open)}
              >
                <span><small>{t('autoMode.dj.label')}</small><strong>{t(activeDj().titleKey)}</strong></span>
                <span>{profileOpen() ? '−' : '+'}</span>
              </button>
              <Show when={profileOpen()}>
                <div class={styles.djProfiles} role="listbox" aria-label={t('autoMode.dj.choose')}>
                  <For each={DJ_PROFILES}>
                    {(profile) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={profile.id === state.autoMode.djProfile}
                        onClick={() => {
                          actions.setAutoDjProfile(profile.id);
                          setProfileOpen(false);
                        }}
                      >
                        <strong>{t(profile.titleKey)}</strong>
                        <small>{t(profile.traitKey)}</small>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>

            <form class={styles.command} onSubmit={(event) => { event.preventDefault(); void submitDirection(); }}>
              <label for="auto-dj-direction">{t('autoMode.dj.tellDj')}</label>
              <input
                id="auto-dj-direction"
                value={prompt()}
                placeholder={t('autoMode.dj.commandPlaceholder')}
                aria-label={t('autoMode.dj.commandAria')}
                onInput={(event) => setPrompt(event.currentTarget.value)}
              />
              <button type="submit" disabled={!prompt().trim()}>{t('autoMode.dj.send')}</button>
            </form>

            <button class={styles.requestButton} type="button" onClick={() => setBoothView('request')}>
              <strong>{t('autoMode.dj.request')}</strong>
              <small>{t('autoMode.dj.requestEta')}</small>
            </button>

            <div class={styles.direction}>
              <DirectionSwitch
                label={t('autoMode.booth.energy')}
                options={[t('autoMode.booth.energyDown'), t('autoMode.booth.hold'), t('autoMode.booth.energyUp')]}
                notes={[t('autoMode.note.energy.down'), t('autoMode.note.energy.hold'), t('autoMode.note.energy.up')]}
                value={state.autoMode.direction?.energy ?? 0}
                onPick={(value, note) => setDirection('energy', value, note)}
              />
              <DirectionSwitch
                label={t('autoMode.booth.crate')}
                options={[t('autoMode.booth.crateDeep'), t('autoMode.booth.hold'), t('autoMode.booth.crateKnown')]}
                notes={[t('autoMode.note.crate.deep'), t('autoMode.note.crate.hold'), t('autoMode.note.crate.known')]}
                value={state.autoMode.direction?.familiarity ?? 0}
                onPick={(value, note) => setDirection('familiarity', value, note)}
              />
            </div>

            <p class={styles.promise}>
              {state.autoMode.pendingDirection || transition().status !== 'idle'
                ? t('autoMode.dj.appliesNext')
                : t('autoMode.dj.directionHint')}
            </p>

            <div class={styles.nextMix}>
              <small>{t('autoMode.booth.next')}</small>
              <span>{nextMix()}</span>
            </div>

            <Show when={state.autoMode.activity && activityVisible()}>
              <p class={styles.activity} data-status={state.autoMode.activity!.status}>
                {activityText(state.autoMode.activity!)}
              </p>
            </Show>

            <Show when={requests().length > 0}>
              <div class={styles.requests}>
                <strong>{t('autoMode.dj.requests')}</strong>
                <For each={requests()}>
                  {(request) => (
                    <div>
                      <span>{request.label}</span>
                      <small>
                        {request.etaTracks !== null
                          ? t('autoMode.dj.withinTracks', { count: request.etaTracks })
                          : t('autoMode.dj.requestUnavailable')}
                      </small>
                      <button
                        type="button"
                        aria-label={t('autoMode.dj.cancelRequest', { title: request.label })}
                        onClick={() => actions.cancelAutoRequest(request.id)}
                      >
                        ×
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </Show>
    </section>
  );

  const Stage = (dragHandle: JSX.Element) => (
    <PlayerStage
      mode="auto"
      surfaceOpen={props.surfaceOpen}
      dragHandle={dragHandle}
      onOpenList={() => props.onPanelChange('route')}
      listActive={props.panel === 'route'}
      listLabel={t('autoMode.mobile.route')}
    />
  );

  const Route = (dragHandle: JSX.Element) => (
    <PlayerTrackList
      title={t('autoMode.dj.route')}
      count={routeEntries().length}
      empty={t('autoMode.mobile.routeEmpty')}
      dragHandle={dragHandle}
      sections={[{ id: 'route', entries: routeEntries() }]}
    />
  );

  return (
    <div
      class={styles.root}
      classList={{ [styles.resting]: resting() }}
      data-playing={state.playback.isPlaying ? 'true' : 'false'}
      onPointerMove={armIdle}
      onPointerDown={armIdle}
      onKeyDown={armIdle}
    >
      <button
        class={styles.focusToggle}
        type="button"
        aria-pressed={stageOnly()}
        onClick={toggleStageOnly}
      >
        {stageOnly() ? t('autoMode.workspace.showAll') : t('autoMode.workspace.stageOnly')}
      </button>
      <PlayerWorkspace
        panels={AUTO_MODE_PANELS}
        activePanel={props.panel}
        onActivePanelChange={props.onPanelChange}
        onCarouselProgress={props.onCarouselProgress}
        surfaceOpen={props.surfaceOpen}
        layout={layout()}
        onLayoutChange={updateLayout}
        minimums={AUTO_MINIMUMS}
        defaults={DEFAULT_AUTO_MODE_LAYOUT.ratios}
        panelLabel={(panel) => t(`autoMode.panel.${panel}`)}
        ariaLabel={t('autoMode.workspace.aria')}
        dataScope="auto"
        soloPanel={stageOnly() ? 'stage' : null}
        class={styles.workspace}
        tileClass={styles.tile}
        renderPanel={(panel, dragHandle) => {
          if (panel === 'booth') return <Booth dragHandle={dragHandle} />;
          if (panel === 'stage') return Stage(dragHandle);
          return Route(dragHandle);
        }}
      />
    </div>
  );
}

export { titleFit } from '../lib/titleFit';
