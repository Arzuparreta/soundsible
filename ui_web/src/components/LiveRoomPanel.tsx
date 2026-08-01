import { createSignal, For, Show } from 'solid-js';
import {
  hostSession,
  joinedSession,
  liveMessages,
  sendChatMessage,
} from '../lib/community';
import { t } from '../lib/i18n';
import styles from './LiveRoomPanel.module.css';

export function LiveRoomPanel(props: { compact?: boolean }) {
  const [text, setText] = createSignal('');
  const session = () => hostSession() ?? joinedSession();
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const value = text().trim();
    if (!value) return;
    sendChatMessage(value);
    setText('');
  };
  return (
    <section class={styles.panel} data-compact={props.compact ? '' : undefined}>
      <header class={styles.header}>
        <div>
          <small>{t('live.onAir')}</small>
          <strong>{session()?.title ?? t('live.chat')}</strong>
        </div>
        <span>{t('live.listeners', { count: session()?.listener_count ?? 0 })}</span>
      </header>
      <div class={styles.messages} aria-live="polite">
        <Show when={liveMessages().length > 0} fallback={<p class={styles.empty}>{t('live.chatEmpty')}</p>}>
          <For each={liveMessages()}>
            {(message) => (
              <p class={styles.message}>
                <strong style={{ color: message.sender.avatar_color ?? undefined }}>
                  {message.sender.display_name}
                </strong>
                <span>{message.text}</span>
              </p>
            )}
          </For>
        </Show>
      </div>
      <form class={styles.form} onSubmit={submit}>
        <input
          value={text()}
          maxlength={500}
          placeholder={t('live.chatPlaceholder')}
          aria-label={t('live.chatPlaceholder')}
          onInput={(event) => setText(event.currentTarget.value)}
        />
        <button type="submit" disabled={!text().trim()}>{t('live.send')}</button>
      </form>
    </section>
  );
}
