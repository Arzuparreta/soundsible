import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { BrandIcon } from '../../components/BrandIcon';
import { Control, InputControl } from '../../design/Control';
import { api, ApiError, type TvAuthRequest } from '../../lib/api';
import { apiOrigin } from '../../lib/config';
import { detectDeviceName } from '../../lib/deviceIdentity';
import { t } from '../../lib/i18n';
import { login, refreshSession } from '../../lib/session';
import QRCode from '../../lib/vendor/qrcode.esm.js';
import { isSuppressedTvKeyRepeat, normalizeTvKey } from '../nav/input';
import { TvFocusProvider, useTvFocus } from '../nav/spatial';
import styles from '../styles/tv.module.css';

interface TvSignInProps {
  onReady?: () => void;
}

type SignInMode = 'phone' | 'pair' | 'password';

const POLL_BACKOFF_MS = [2000, 3000, 4000, 5000];

function TvSignInInner(props: TvSignInProps) {
  const focus = useTvFocus();

  const initialDeviceName = () => {
    try {
      return localStorage.getItem('device_name') || detectDeviceName();
    } catch {
      return detectDeviceName();
    }
  };

  const [mode, setMode] = createSignal<SignInMode>('phone');
  const [roomName, setRoomName] = createSignal(initialDeviceName());
  const [roomSaved, setRoomSaved] = createSignal(false);

  // Phone QR device authorization state
  const [authReq, setAuthReq] = createSignal<TvAuthRequest | null>(null);
  const [qrDataUrl, setQrDataUrl] = createSignal<string>('');
  const [qrStatus, setQrStatus] = createSignal<'loading' | 'pending' | 'approving' | 'denied' | 'expired' | 'error'>('loading');
  const [qrError, setQrError] = createSignal<string | null>(null);

  // Pairing code claim state
  const [pairCode, setPairCode] = createSignal('');
  const [pairBusy, setPairBusy] = createSignal(false);
  const [pairError, setPairError] = createSignal<string | null>(null);

  // Password login state
  const [username, setUsername] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [loginBusy, setLoginBusy] = createSignal(false);
  const [loginError, setLoginError] = createSignal<string | null>(null);

  let disposed = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollAttempt = 0;
  let activeGeneration = 0;

  function clearPollTimer(): void {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function cancelActiveRequest(handle?: string | null): void {
    clearPollTimer();
    const target = handle ?? authReq()?.redemption_handle;
    if (target) {
      void api.cancelTvAuthRequest(target).catch(() => {});
    }
  }

  async function startPhoneRequest(deviceLabel = roomName()): Promise<void> {
    const gen = ++activeGeneration;
    cancelActiveRequest();
    setAuthReq(null);
    setQrDataUrl('');
    setQrError(null);
    setQrStatus('loading');
    pollAttempt = 0;

    try {
      const req = await api.createTvAuthRequest(deviceLabel.trim() || initialDeviceName());
      if (disposed || gen !== activeGeneration || mode() !== 'phone') {
        void api.cancelTvAuthRequest(req.redemption_handle).catch(() => {});
        return;
      }
      setAuthReq(req);
      setQrStatus('pending');
      try {
        const dataUrl = await QRCode.toDataURL(req.approve_url, {
          width: 320,
          margin: 2,
        });
        if (!disposed && gen === activeGeneration) setQrDataUrl(dataUrl);
      } catch {
        // Code + text URL still allow manual entry on a phone.
      }
      scheduleNextPoll(req.redemption_handle, gen);
    } catch {
      if (!disposed && gen === activeGeneration) {
        setQrStatus('error');
        setQrError(t('tv.signIn.failed'));
      }
    }
  }

  function scheduleNextPoll(handle: string, gen: number): void {
    clearPollTimer();
    if (disposed || gen !== activeGeneration || mode() !== 'phone') return;
    const delay = POLL_BACKOFF_MS[Math.min(pollAttempt, POLL_BACKOFF_MS.length - 1)];
    pollAttempt += 1;
    pollTimer = setTimeout(() => {
      void pollOnce(handle, gen);
    }, delay);
  }

  async function pollOnce(handle: string, gen: number): Promise<void> {
    if (disposed || gen !== activeGeneration || mode() !== 'phone') return;
    try {
      const status = await api.getTvAuthStatus(handle);
      if (disposed || gen !== activeGeneration || mode() !== 'phone') return;
      if (status.status === 'pending') {
        scheduleNextPoll(handle, gen);
        return;
      }
      if (status.status === 'approved') {
        setQrStatus('approving');
        await api.redeemTvAuthRequest(handle);
        if (disposed || gen !== activeGeneration) return;
        await refreshSession();
        return;
      }
      if (status.status === 'denied') {
        setQrStatus('denied');
        return;
      }
      if (status.status === 'expired' || status.status === 'cancelled' || status.status === 'redeemed') {
        setQrStatus('expired');
        return;
      }
      scheduleNextPoll(handle, gen);
    } catch (err) {
      if (disposed || gen !== activeGeneration) return;
      if (err instanceof ApiError && (err.code === 'not_found' || err.code === 'expired')) {
        setQrStatus('expired');
        return;
      }
      scheduleNextPoll(handle, gen);
    }
  }

  function switchMode(next: SignInMode): void {
    if (next === mode()) return;
    if (mode() === 'phone') {
      cancelActiveRequest();
    }
    setMode(next);
    if (next === 'phone') {
      void startPhoneRequest();
    }
    queueMicrotask(() => {
      focus.reconcileFocus();
    });
  }

  function saveRoomLabel(): void {
    const cleaned = roomName().trim();
    if (!cleaned) return;
    try {
      localStorage.setItem('device_name', cleaned);
    } catch { /* ignore storage restrictions */ }
    setRoomName(cleaned);
    setRoomSaved(true);
    if (mode() === 'phone') {
      void startPhoneRequest(cleaned);
    }
  }

  async function submitPairingCode(e: Event): Promise<void> {
    e.preventDefault();
    const cleaned = pairCode().trim();
    if (!cleaned || pairBusy()) return;
    setPairBusy(true);
    setPairError(null);
    try {
      await api.claimPairingSession(cleaned, roomName().trim() || initialDeviceName());
      await refreshSession();
    } catch (err) {
      setPairError(err instanceof Error ? err.message : t('tv.signIn.failed'));
    } finally {
      setPairBusy(false);
    }
  }

  async function submitPasswordLogin(e: Event): Promise<void> {
    e.preventDefault();
    const u = username().trim();
    const p = password();
    if (!u || !p || loginBusy()) return;
    setLoginBusy(true);
    setLoginError(null);
    try {
      await login(u, p);
      await refreshSession();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : t('tv.signIn.failed'));
    } finally {
      setLoginBusy(false);
    }
  }

  onMount(() => {
    props.onReady?.();
    void startPhoneRequest();
    queueMicrotask(() => {
      focus.focusById('signin-tab-phone');
    });

    const onKeyDown = (event: KeyboardEvent) => {
      const action = normalizeTvKey(event, document.activeElement);
      if (!action) {
        if (isSuppressedTvKeyRepeat(event, document.activeElement)) {
          event.preventDefault();
        }
        return;
      }
      if (action === 'up' || action === 'down' || action === 'left' || action === 'right') {
        event.preventDefault();
        focus.move(action);
      } else if (action === 'select') {
        const active = document.activeElement as HTMLElement | null;
        if (active?.dataset?.tvId) {
          event.preventDefault();
          active.click();
        }
      } else if (action === 'back') {
        const active = document.activeElement as HTMLElement | null;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
          event.preventDefault();
          active.blur();
          focus.focusById(`signin-tab-${mode()}`);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    onCleanup(() => {
      disposed = true;
      activeGeneration += 1;
      cancelActiveRequest();
      window.removeEventListener('keydown', onKeyDown, true);
    });
  });

  return (
    <main class={styles.tvSignInPage} data-tv-scroll-y="main" aria-labelledby="tv-signin-heading">
      <header class={styles.tvHeaderBar}>
        <div class={styles.tvSignInIdentity}>
          <BrandIcon />
          <h1 id="tv-signin-heading" class={styles.tvPageTitle}>{t('tv.signIn.title')}</h1>
        </div>
        <div class={styles.tvAccountPill}>
          {t('tv.signIn.stationUrl')}: {apiOrigin()}
        </div>
      </header>

      <div
        class={styles.tvTabs}
        data-tv-group-container="signin-tabs"
        data-tv-group-kind="row"
        data-tv-group-order="10"
        data-tv-rail-edge="none"
        role="tablist"
      >
        <Control
          id="signin-tab-phone"
          role="tab"
          aria-selected={mode() === 'phone'}
          data-tv-id="signin-tab-phone"
          data-tv-group="signin-tabs"
          data-tv-index="0"
          data-tv-focused={focus.activeId() === 'signin-tab-phone' ? 'true' : undefined}
          class={styles.tvSecondaryBtn}
          classList={{
            [styles.tvFocusTarget]: true,
            [styles.tvSelectedBtn]: mode() === 'phone',
          }}
          onClick={() => switchMode('phone')}
        >
          {t('tv.signIn.tabPhone')}
        </Control>
        <Control
          role="tab"
          aria-selected={mode() === 'pair'}
          data-tv-id="signin-tab-pair"
          data-tv-group="signin-tabs"
          data-tv-index="1"
          data-tv-focused={focus.activeId() === 'signin-tab-pair' ? 'true' : undefined}
          class={styles.tvSecondaryBtn}
          classList={{
            [styles.tvFocusTarget]: true,
            [styles.tvSelectedBtn]: mode() === 'pair',
          }}
          onClick={() => switchMode('pair')}
        >
          {t('tv.signIn.tabPair')}
        </Control>
        <Control
          role="tab"
          aria-selected={mode() === 'password'}
          data-tv-id="signin-tab-password"
          data-tv-group="signin-tabs"
          data-tv-index="2"
          data-tv-focused={focus.activeId() === 'signin-tab-password' ? 'true' : undefined}
          class={styles.tvSecondaryBtn}
          classList={{
            [styles.tvFocusTarget]: true,
            [styles.tvSelectedBtn]: mode() === 'password',
          }}
          onClick={() => switchMode('password')}
        >
          {t('tv.signIn.tabPassword')}
        </Control>
      </div>

      <Show when={mode() === 'phone'}>
        <section
          class={styles.tvSignInGrid}
          data-tv-group-container="signin-phone-actions"
          data-tv-group-kind="row"
          data-tv-group-order="30"
          data-tv-rail-edge="none"
        >
          <div class={styles.tvQrFrame}>
            <Show
              when={qrDataUrl()}
              fallback={<div class={styles.tvArtFallback} aria-hidden="true">QR</div>}
            >
              <img class={styles.tvQrImg} src={qrDataUrl()} alt={t('tv.signIn.qrAlt')} />
            </Show>
          </div>
          <div class={styles.tvDetailInfo}>
            <p class={styles.tvSubtitle}>{t('tv.signIn.step1')}</p>
            <Show when={authReq()}>
              {(req) => (
                <>
                  <div class={styles.tvAccountPill}>{req().approve_url}</div>
                  <p class={styles.tvSubtitle}>{t('tv.signIn.step2')}</p>
                  <div class={styles.tvCodeDisplay} data-testid="tv-auth-code">
                    {req().code}
                  </div>
                </>
              )}
            </Show>
            <Show when={qrStatus() === 'pending'}>
              <p class={styles.tvSubtitle} role="status">{t('tv.signIn.waiting')}</p>
            </Show>
            <Show when={qrStatus() === 'approving'}>
              <p class={styles.tvSubtitle} role="status">{t('tv.signIn.approving')}</p>
            </Show>
            <Show when={qrStatus() === 'denied'}>
              <p class={styles.tvErrorText} role="alert">{t('tv.signIn.denied')}</p>
            </Show>
            <Show when={qrStatus() === 'expired'}>
              <p class={styles.tvErrorText} role="alert">{t('tv.signIn.expired')}</p>
            </Show>
            <Show when={qrStatus() === 'error'}>
              <p class={styles.tvErrorText} role="alert">{qrError() || t('tv.signIn.failed')}</p>
            </Show>
            <div class={styles.tvRowGroup}>
              <Control
                data-tv-id="signin-new-code"
                data-tv-group="signin-phone-actions"
                data-tv-index="0"
                data-tv-focused={focus.activeId() === 'signin-new-code' ? 'true' : undefined}
                class={styles.tvPrimaryBtn}
                classList={{ [styles.tvFocusTarget]: true }}
                onClick={() => void startPhoneRequest()}
              >
                {t('tv.signIn.newCode')}
              </Control>
            </div>
          </div>
        </section>
      </Show>

      <Show when={mode() === 'pair'}>
        <form
          class={styles.tvFormCard}
          data-tv-group-container="signin-pair-form"
          data-tv-group-kind="list"
          data-tv-group-order="30"
          data-tv-rail-edge="none"
          onSubmit={(e) => void submitPairingCode(e)}
        >
          <p class={styles.tvSubtitle}>{t('tv.signIn.pairHint')}</p>
          <InputControl
            aria-label={t('tv.signIn.pairCodePlaceholder')}
            data-tv-id="signin-pair-input"
            data-tv-group="signin-pair-form"
            data-tv-index="0"
            data-tv-focused={focus.activeId() === 'signin-pair-input' ? 'true' : undefined}
            class={styles.tvInput}
            classList={{ [styles.tvFocusTarget]: true }}
            type="text"
            placeholder={t('tv.signIn.pairCodePlaceholder')}
            value={pairCode()}
            onInput={(e) => setPairCode(e.currentTarget.value)}
          />
          <Show when={pairError()}>
            <p class={styles.tvErrorText} role="alert">{pairError()}</p>
          </Show>
          <Control
            type="submit"
            data-tv-id="signin-pair-submit"
            data-tv-group="signin-pair-form"
            data-tv-index="1"
            data-tv-focused={focus.activeId() === 'signin-pair-submit' ? 'true' : undefined}
            class={styles.tvPrimaryBtn}
            classList={{ [styles.tvFocusTarget]: true }}
            disabled={pairBusy()}
          >
            {t('tv.signIn.pairSubmit')}
          </Control>
        </form>
      </Show>

      <Show when={mode() === 'password'}>
        <form
          class={styles.tvFormCard}
          data-tv-group-container="signin-password-form"
          data-tv-group-kind="list"
          data-tv-group-order="30"
          data-tv-rail-edge="none"
          onSubmit={(e) => void submitPasswordLogin(e)}
        >
          <InputControl
            aria-label={t('tv.signIn.username')}
            data-tv-id="signin-user-input"
            data-tv-group="signin-password-form"
            data-tv-index="0"
            data-tv-focused={focus.activeId() === 'signin-user-input' ? 'true' : undefined}
            class={styles.tvInput}
            classList={{ [styles.tvFocusTarget]: true }}
            type="text"
            autocomplete="username"
            placeholder={t('tv.signIn.username')}
            value={username()}
            onInput={(e) => setUsername(e.currentTarget.value)}
          />
          <InputControl
            aria-label={t('tv.signIn.password')}
            data-tv-id="signin-pass-input"
            data-tv-group="signin-password-form"
            data-tv-index="1"
            data-tv-focused={focus.activeId() === 'signin-pass-input' ? 'true' : undefined}
            class={styles.tvInput}
            classList={{ [styles.tvFocusTarget]: true }}
            type="password"
            autocomplete="current-password"
            placeholder={t('tv.signIn.password')}
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
          <Show when={loginError()}>
            <p class={styles.tvErrorText} role="alert">{loginError()}</p>
          </Show>
          <Control
            type="submit"
            data-tv-id="signin-password-submit"
            data-tv-group="signin-password-form"
            data-tv-index="2"
            data-tv-focused={focus.activeId() === 'signin-password-submit' ? 'true' : undefined}
            class={styles.tvPrimaryBtn}
            classList={{ [styles.tvFocusTarget]: true }}
            disabled={loginBusy()}
          >
            {t('tv.signIn.passwordSubmit')}
          </Control>
        </form>
      </Show>

      <div
        class={styles.tvRoomName}
        data-tv-group-container="signin-room"
        data-tv-group-kind="row"
        data-tv-group-order="40"
        data-tv-rail-edge="none"
      >
        <label for="tv-room-name" class={styles.tvSubtitle}>{t('tv.signIn.roomLabel')}</label>
        <InputControl
          id="tv-room-name"
          aria-label={t('tv.signIn.roomLabel')}
          data-tv-id="signin-room-input"
          data-tv-group="signin-room"
          data-tv-index="0"
          data-tv-focused={focus.activeId() === 'signin-room-input' ? 'true' : undefined}
          class={styles.tvInput}
          classList={{ [styles.tvFocusTarget]: true }}
          type="text"
          value={roomName()}
          onInput={(e) => {
            setRoomSaved(false);
            setRoomName(e.currentTarget.value);
          }}
        />
        <Control
          data-tv-id="signin-room-save"
          data-tv-group="signin-room"
          data-tv-index="1"
          data-tv-focused={focus.activeId() === 'signin-room-save' ? 'true' : undefined}
          class={styles.tvSecondaryBtn}
          classList={{ [styles.tvFocusTarget]: true }}
          onClick={saveRoomLabel}
        >
          {t('tv.signIn.roomSave')}
        </Control>
        <Show when={roomSaved()}>
          <span class={styles.tvAccountPill}>
            {t('tv.account.roomSaved', { name: roomName() })}
          </span>
        </Show>
      </div>
    </main>
  );
}

export function TvSignIn(props: TvSignInProps) {
  return (
    <TvFocusProvider>
      <TvSignInInner onReady={props.onReady} />
    </TvFocusProvider>
  );
}
