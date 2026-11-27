import { createSignal, onCleanup, onMount, Show, type Component } from 'solid-js';
import { render } from 'solid-js/web';
import '../boot/fonts';
import '../styles/tokens.css';
import { Control } from '../design/Control';
import { initLocale, t } from '../lib/i18n';
import {
  installSessionGuard,
  ready,
  recoverSession,
  refreshSession,
  requiresLogin,
  sessionUnavailable,
  user,
} from '../lib/session';
import { TvSignIn } from './screens/TvSignIn';
import styles from './styles/tv.module.css';

declare global {
  interface Window {
    __SOUNDSIBLE_TV_BOOT__?: {
      ready: () => void;
      fail: (reason?: string) => void;
    };
  }
}

document.documentElement.dataset.surface = 'tv';
document.documentElement.dataset.theme = 'dark';

void initLocale();
installSessionGuard();
const stopSessionRecovery = recoverSession();
if (import.meta.hot) import.meta.hot.dispose(stopSessionRecovery);

function notifyBootReady(): void {
  window.__SOUNDSIBLE_TV_BOOT__?.ready();
}

function TvOfflineRecovery() {
  onMount(() => {
    notifyBootReady();
  });

  return (
    <main class={styles.tvSignInPage}>
      <section class={styles.tvEmptyPanel}>
        <h1 class={styles.tvPageTitle}>{t('tv.bootOfflineTitle')}</h1>
        <p class={styles.tvSubtitle}>{t('tv.bootOfflineBody')}</p>
        <Control class={styles.tvPrimaryBtn} onClick={() => void refreshSession()}>
          {t('tv.retry')}
        </Control>
      </section>
    </main>
  );
}

function TvSignedInBoundary() {
  const [failed, setFailed] = createSignal(false);
  const [component, setComponent] = createSignal<Component<{ onReady?: () => void }> | null>(null);

  // Use explicit dynamic import so chunk load failure surfaces an accessible TV reload screen.
  const loadApp = () => {
    setFailed(false);
    import('./TvApp')
      .then((mod) => setComponent(() => mod.default))
      .catch(() => {
        setFailed(true);
        notifyBootReady();
      });
  };

  onMount(loadApp);

  return (
    <Show
      when={!failed()}
      fallback={
        <main class={styles.tvSignInPage}>
          <section class={styles.tvEmptyPanel}>
            <h1 class={styles.tvPageTitle}>{t('tv.bootOfflineTitle')}</h1>
            <Control class={styles.tvPrimaryBtn} onClick={loadApp}>
              {t('tv.reload')}
            </Control>
          </section>
        </main>
      }
    >
      <Show when={component()} fallback={<div />}>
        {(Loaded) => {
          const Comp = Loaded();
          return <Comp onReady={notifyBootReady} />;
        }}
      </Show>
    </Show>
  );
}

function TvBootstrap() {
  onMount(() => {
    void refreshSession();
    const timer = window.setInterval(() => {
      if (!ready() && sessionUnavailable()) void refreshSession();
    }, 15000);
    onCleanup(() => window.clearInterval(timer));
  });

  const authenticated = () => ready() && !sessionUnavailable() && (!requiresLogin() || user() !== null);
  const accountScopeKey = () => (authenticated() ? user()?.id ?? '__station__' : undefined);

  return (
    <Show when={ready()}>
      <Show when={!sessionUnavailable() || user() || !requiresLogin()} fallback={<TvOfflineRecovery />}>
        <Show when={accountScopeKey()} keyed fallback={<TvSignIn onReady={notifyBootReady} />}>
          <TvSignedInBoundary />
        </Show>
      </Show>
    </Show>
  );
}

const mountNode = document.getElementById('root');
if (!mountNode) {
  window.__SOUNDSIBLE_TV_BOOT__?.fail('Missing #root container for Soundsible TV.');
} else {
  render(() => <TvBootstrap />, mountNode);
}
