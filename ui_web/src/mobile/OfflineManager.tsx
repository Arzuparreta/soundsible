import { For, Show } from 'solid-js';
import { t } from '../lib/i18n';
import { openOverlay } from '../lib/overlay';
import type { MenuAction } from '../components/ActionMenu';
import type { Track } from '../types/music';
import styles from './OfflineManager.module.css';
import { acquiredMusic, type OfflineState, type OfflineCommand } from './offline';

export function offlineActions(tracks: Track[], state: () => OfflineState | null, execute: (command: OfflineCommand) => Promise<void>, generation: () => number): MenuAction[] {
  const captured = generation();
  const local = acquiredMusic(tracks);
  if (!local.length) return [];
  const items = state()?.items ?? [];
  const existing = local.filter(track => items.some(item => item.track.id === track.id));
  const pending = existing.some(track => items.some(item => item.track.id === track.id && (item.state === 'queued' || item.state === 'downloading')));
  const ready = local.every(track => items.some(item => item.track.id === track.id && item.state === 'ready'));
  const run = (command: OfflineCommand) => { if (captured === generation()) void execute(command); };
  return [
    { label: t('android.offlineAvailable'), selected: ready, disabled: ready || pending, onSelect: () => run({ action: 'prepare', tracks: local, playlists: state()?.playlists ?? {} }) },
    ...(existing.length ? [{ label: t(pending ? 'android.offlineCancel' : 'android.offlineRemove'), onSelect: () => run({ action: 'remove', ids: existing.map(track => track.id) }) }] : []),
  ];
}
const space = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
export function openOfflineManager(state: () => OfflineState | null, execute: (command: OfflineCommand) => Promise<void>) {
  openOverlay(close => <section class={styles.manager} data-testid="android-offline-manager">
    <h2>{t('android.offlineManage')}</h2><button onClick={() => close()}>{t('common.close')}</button>
    <p>{space(state()?.usedBytes ?? 0)} / {space(state()?.limitBytes ?? 0)}</p>
    <label>{t('android.offlineSpace')} <select value={state()?.limitBytes} onChange={event => void execute({ action: 'limit', bytes: Number(event.currentTarget.value) })}>
      <For each={[512 * 1024 ** 2, 2 * 1024 ** 3, 8 * 1024 ** 3]}>{bytes => <option value={bytes}>{space(bytes)}</option>}</For>
    </select></label>
    <Show when={state()?.items.length} fallback={<p>{t('android.offlineEmpty')}</p>}>
      <p>{state()?.items.filter(item => item.state === 'ready').length} / {state()?.items.length} · {t('android.offlineReady')}</p>
      <For each={state()?.items}>{item => <div class={styles.item}><p>{item.track.title} · {item.track.artist}</p>
        <Show when={item.state === 'queued' || item.state === 'downloading'}><progress aria-label={t('android.offlinePreparing')} max={item.total || undefined} value={item.total ? item.bytes : undefined} /></Show>
        <Show when={item.state === 'ready'}><small>{t('android.offlineAvailable')}</small></Show>
        <Show when={item.state === 'error'}><p role="status">{t(item.error === 'space' ? 'android.offlineNoSpace' : item.error === 'permission' ? 'android.permissionDenied' : item.error === 'integrity' ? 'android.offlineIntegrity' : 'android.offlineFailed')}</p><button onClick={() => void execute({ action: 'prepare', tracks: [item.track], playlists: state()?.playlists ?? {} })}>{t('common.retry')}</button></Show>
        <button onClick={() => void execute({ action: 'remove', ids: [item.track.id] })}>{t(item.state === 'queued' || item.state === 'downloading' ? 'android.offlineCancel' : 'android.offlineRemove')}</button>
      </div>}</For>
    </Show>
  </section>, { ariaLabel: t('android.offlineManage') });
}
