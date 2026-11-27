import { createSignal, Show } from 'solid-js';
import { Control, InputControl } from '../../design/Control';
import { apiOrigin } from '../../lib/config';
import { t } from '../../lib/i18n';
import { requiresLogin, user } from '../../lib/session';
import { actions, state } from '../../stores';
import { useTvFocus } from '../nav/spatial';
import { showTvNotice } from '../state';
import styles from '../styles/tv.module.css';

interface TvAccountProps {
  onRequestSignOut: () => void;
}

export function TvAccount(props: TvAccountProps) {
  const focus = useTvFocus();
  const [roomInput, setRoomInput] = createSignal(state.device.device_name);

  function saveRoomName(e: Event): void {
    e.preventDefault();
    const cleaned = roomInput().trim();
    if (!cleaned) return;
    actions.setDeviceName(cleaned);
    setRoomInput(cleaned);
    showTvNotice(t('tv.account.roomSaved', { name: cleaned }));
  }

  const tvUrl = () => `${apiOrigin()}/tv/`;
  const viewportWidth = () => (typeof window !== 'undefined' ? window.innerWidth : 1920);
  const viewportHeight = () => (typeof window !== 'undefined' ? window.innerHeight : 1080);

  return (
    <>
      <header class={styles.tvHeaderBar}>
        <h1 class={styles.tvPageTitle}>{t('tv.account.title')}</h1>
      </header>

      <section
        class={styles.tvFormCard}
        data-tv-group-container="account-user"
        data-tv-group-kind="row"
        data-tv-group-order="10"
      >
        <h2 class={styles.tvSectionTitle}>{t('tv.account.userHeading')}</h2>
        <Show when={user()}>
          {(account) => (
            <p class={styles.tvSubtitle}>
              {account().display_name || account().username} (@{account().username}) · {account().role}
            </p>
          )}
        </Show>
        <Show when={requiresLogin()}>
          <div>
            <Control
              data-tv-id="account-signout-btn"
              data-tv-group="account-user"
              data-tv-index="0"
              data-tv-focused={focus.activeId() === 'account-signout-btn' ? 'true' : undefined}
              class={styles.tvDangerBtn}
              classList={{ [styles.tvFocusTarget]: true }}
              onClick={props.onRequestSignOut}
            >
              {t('tv.signOut')}
            </Control>
          </div>
        </Show>
      </section>

      <form
        class={styles.tvFormCard}
        data-tv-group-container="account-tv-name"
        data-tv-group-kind="row"
        data-tv-group-order="20"
        onSubmit={saveRoomName}
      >
        <h2 class={styles.tvSectionTitle}>{t('tv.account.tvHeading')}</h2>
        <p class={styles.tvSubtitle}>
          {t('tv.signIn.stationUrl')}: {tvUrl()}
        </p>
        <div class={styles.tvRowGroup}>
          <InputControl
            aria-label={t('tv.signIn.roomLabel')}
            data-tv-id="account-room-input"
            data-tv-group="account-tv-name"
            data-tv-index="0"
            data-tv-focused={focus.activeId() === 'account-room-input' ? 'true' : undefined}
            class={styles.tvInput}
            classList={{ [styles.tvFocusTarget]: true }}
            type="text"
            value={roomInput()}
            onInput={(e) => setRoomInput(e.currentTarget.value)}
          />
          <Control
            type="submit"
            data-tv-id="account-room-save"
            data-tv-group="account-tv-name"
            data-tv-index="1"
            data-tv-focused={focus.activeId() === 'account-room-save' ? 'true' : undefined}
            class={styles.tvPrimaryBtn}
            classList={{ [styles.tvFocusTarget]: true }}
          >
            {t('tv.signIn.roomSave')}
          </Control>
        </div>
      </form>

      <section class={styles.tvFormCard}>
        <h2 class={styles.tvSectionTitle}>{t('tv.account.diagnostics')}</h2>
        <p class={styles.tvSubtitle}>
          {t('tv.account.formFactor', { value: state.device.form_factor })}
        </p>
        <p class={styles.tvSubtitle}>
          {t('tv.account.commandsCount', { count: state.device.commands.length })}
        </p>
        <p class={styles.tvSubtitle}>
          {t('tv.account.connectionState', {
            state: state.online ? t('tv.account.connected') : t('tv.account.offline'),
          })}
        </p>
        <p class={styles.tvSubtitle}>
          {t('tv.account.viewport', { width: viewportWidth(), height: viewportHeight() })}
        </p>
      </section>
    </>
  );
}
