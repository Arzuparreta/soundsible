import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { actions, state } from '../stores';
import { user } from '../lib/session';
import {
  communityConfig,
  communityError,
  createHostSession,
  endHostSession,
  hostSession,
  joinedSession,
  joinLiveSession,
  leaveLiveSession,
  listenerStream,
  liveProgram,
  liveSessions,
  publisherConnected,
  refreshLiveSessions,
  startListening,
  updateHostTitle,
  type LiveDeck,
  type LiveSession,
} from '../lib/community';
import { t } from '../lib/i18n';
import { ViewHeader } from '../components/ViewHeader';
import { LiveRoomPanel } from '../components/LiveRoomPanel';
import styles from './Live.module.css';

function DeckLine(props: { deck: LiveDeck | null | undefined; secondary?: boolean }) {
  return (
    <Show when={props.deck}>
      {(value) => (
        <div class={styles.deck} data-secondary={props.secondary ? '' : undefined}>
          <span class={styles.deckArt}>
            <Show when={value().artwork_url} fallback={<span>♪</span>}>
              <img src={value().artwork_url!} alt="" />
            </Show>
          </span>
          <span>
            <strong>{value().title}</strong>
            <small>{value().artist}</small>
          </span>
        </div>
      )}
    </Show>
  );
}

function SessionCard(props: { session: LiveSession; onJoin: () => void }) {
  return (
    <button class={styles.card} type="button" onClick={props.onJoin}>
      <div class={styles.cardHead}>
        <span class={styles.avatar} style={{ background: props.session.host.avatar_color ?? undefined }}>
          {props.session.host.display_name.slice(0, 1).toUpperCase()}
        </span>
        <span>
          <strong>{props.session.title}</strong>
          <small>{props.session.host.display_name}</small>
        </span>
        <span class={styles.status} data-status={props.session.status}>
          {t(`live.status.${props.session.status}`)}
        </span>
      </div>
      <Show when={props.session.program?.primary} fallback={<p class={styles.waiting}>{t('live.waiting')}</p>}>
        <DeckLine deck={props.session.program?.primary} />
        <Show when={props.session.program?.secondary}>
          <div class={styles.transitionBar}>
            <span style={{ width: `${Math.round((props.session.program?.transition?.progress ?? 0) * 100)}%` }} />
          </div>
          <DeckLine deck={props.session.program?.secondary} secondary />
        </Show>
      </Show>
      <footer>{t('live.listeners', { count: props.session.listener_count })}</footer>
    </button>
  );
}

function ListenerRoom() {
  let audio: HTMLAudioElement | undefined;
  const [starting, setStarting] = createSignal(false);
  const [failed, setFailed] = createSignal(false);

  createEffect(() => {
    const stream = listenerStream();
    if (audio && stream) audio.srcObject = stream;
  });

  const listen = async () => {
    setStarting(true);
    setFailed(false);
    try {
      const stream = await startListening();
      if (audio) {
        audio.srcObject = stream;
        await audio.play();
      }
    } catch {
      setFailed(true);
    } finally {
      setStarting(false);
    }
  };

  return (
    <section class={styles.room}>
      <div class={styles.roomStage}>
        <div class={styles.roomTop}>
          <button type="button" onClick={() => void leaveLiveSession()}>{t('common.back')}</button>
          <span>{joinedSession()?.host.display_name}</span>
        </div>
        <div class={styles.heroArt}>
          <Show when={liveProgram()?.primary?.artwork_url} fallback={<span>♪</span>}>
            <img src={liveProgram()!.primary!.artwork_url!} alt="" />
          </Show>
        </div>
        <div class={styles.now}>
          <span>{t(`live.status.${joinedSession()?.status ?? 'waiting'}`)}</span>
          <h2>{liveProgram()?.primary?.title ?? joinedSession()?.title}</h2>
          <p>{liveProgram()?.primary?.artist ?? t('live.waiting')}</p>
        </div>
        <Show when={liveProgram()?.secondary}>
          <div class={styles.blend}>
            <small>{liveProgram()?.transition?.technique?.replaceAll('_', ' ')}</small>
            <div><span style={{ width: `${Math.round((liveProgram()?.transition?.progress ?? 0) * 100)}%` }} /></div>
            <strong>{liveProgram()?.secondary?.title}</strong>
          </div>
        </Show>
        <audio ref={audio} autoplay />
        <button
          class={styles.listen}
          type="button"
          disabled={starting() || !liveProgram()?.primary}
          onClick={() => void listen()}
        >
          {listenerStream()
            ? t('live.listening')
            : starting()
              ? t('common.loading')
              : liveProgram()?.primary
                ? t('live.listen')
                : t('live.waiting')}
        </button>
        <Show when={failed()}><p class={styles.error}>{t('live.listenFailed')}</p></Show>
      </div>
      <LiveRoomPanel />
    </section>
  );
}

export default function Live() {
  const [title, setTitle] = createSignal('');
  const [creating, setCreating] = createSignal(false);
  const [editing, setEditing] = createSignal(false);
  let refreshTimer: number | undefined;

  onMount(() => {
    setTitle(`Session by ${user()?.display_name ?? 'DJ'}`);
    void refreshLiveSessions();
    refreshTimer = window.setInterval(() => void refreshLiveSessions(), 10_000);
  });
  onCleanup(() => window.clearInterval(refreshTimer));

  const create = async () => {
    setCreating(true);
    try {
      await createHostSession(title());
    } finally {
      setCreating(false);
    }
  };

  const join = (session: LiveSession) => {
    if (state.playback.isPlaying) actions.togglePlay();
    joinLiveSession(session);
  };

  return (
    <div class={styles.page}>
      <Show when={!joinedSession()} fallback={<ListenerRoom />}>
        <ViewHeader
          title={t('live.title')}
          meta={t('live.meta')}
          actions={
            <Show
              when={hostSession()}
              fallback={
                <button class={styles.goLive} type="button" disabled={creating() || !communityConfig()?.enabled} onClick={() => void create()}>
                  {creating() ? t('common.loading') : t('live.goLive')}
                </button>
              }
            >
              <button class={styles.endLive} type="button" onClick={() => void endHostSession()}>
                {t('live.end')}
              </button>
            </Show>
          }
        />

        <Show when={communityError()}>
          <div class={styles.banner}>{t('live.unavailable')}</div>
        </Show>

        <Show when={hostSession()}>
          {(session) => (
            <section class={styles.hostCard}>
              <div>
                <span class={styles.onAir}>{publisherConnected() ? t('live.onAir') : t('live.waiting')}</span>
                <Show
                  when={editing()}
                  fallback={<h2 onDblClick={() => setEditing(true)}>{session().title}</h2>}
                >
                  <form onSubmit={(event) => {
                    event.preventDefault();
                    void updateHostTitle(title()).then(() => setEditing(false));
                  }}>
                    <input value={title()} maxlength={96} onInput={(event) => setTitle(event.currentTarget.value)} />
                    <button type="submit">{t('common.save')}</button>
                  </form>
                </Show>
                <p>{publisherConnected() ? t('live.broadcasting') : t('live.startPlaying')}</p>
              </div>
              <LiveRoomPanel compact />
            </section>
          )}
        </Show>

        <section class={styles.directory}>
          <div class={styles.directoryHead}>
            <h2>{t('live.directory')}</h2>
            <button type="button" onClick={() => void refreshLiveSessions()}>{t('live.refresh')}</button>
          </div>
          <Show when={liveSessions().length > 0} fallback={<p class={styles.empty}>{t('live.empty')}</p>}>
            <div class={styles.grid}>
              <For each={liveSessions()}>
                {(session) => <SessionCard session={session} onJoin={() => join(session)} />}
              </For>
            </div>
          </Show>
        </section>
      </Show>
    </div>
  );
}
