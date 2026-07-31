import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { api, type LosslessStatus } from '../lib/api';
import { t } from '../lib/i18n';
import { toast } from '../lib/toast';
import { confirmDialog } from '../lib/confirm';
import { ActionRow, InputRow, SettingsGroup, SwitchRow, ValueRow } from './SettingsRows';

/**
 * Manual control over the lossless upgrade worker.
 *
 * The worker normally waits for a fully idle instance, which makes it invisible
 * and — when it finds nothing for days — indistinguishable from broken. This
 * panel is the answer to "is it doing anything?": it names the state, counts
 * what happened, and lets you run it right now, pause it, or stop it.
 */

const IDLE_POLL_MS = 15000;
const ACTIVE_POLL_MS = 2000;

function activityLabel(status: LosslessStatus): string {
  const key = status.manual?.state === 'paused' ? 'paused' : status.activity;
  const known: Record<string, string> = {
    stopped: t('settings.losslessStateStopped'),
    disabled: t('settings.losslessStateDisabled'),
    waiting: t('settings.losslessStateWaiting'),
    idle: t('settings.losslessStateIdle'),
    inventory: t('settings.losslessStateInventory'),
    processing: t('settings.losslessStateProcessing'),
    paused: t('settings.losslessStatePaused'),
    budget_exhausted: t('settings.losslessStateBudget'),
    unavailable: t('settings.losslessUnavailable'),
  };
  return known[key] ?? key;
}

export function LosslessUpgrades() {
  const [status, setStatus] = createSignal<LosslessStatus | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [jamendoClientId, setJamendoClientId] = createSignal('');
  let timer: ReturnType<typeof setTimeout> | undefined;

  const running = () => status()?.manual?.state === 'running';
  const paused = () => status()?.manual?.state === 'paused';
  const count = (key: string) => status()?.counts?.[key] ?? 0;
  const pending = () => count('pending') + count('retry') + count('committing');
  const jamendoReady = () =>
    status()?.providers?.some((provider) => provider.name === 'jamendo' && provider.available) ?? false;

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, running() || paused() ? ACTIVE_POLL_MS : IDLE_POLL_MS);
  };

  const refresh = async () => {
    try {
      setStatus(await api.getLosslessStatus());
    } catch {
      /* the panel simply keeps the last snapshot */
    }
    schedule();
  };

  /** Every control returns a fresh snapshot, so adopt it and re-time the poll. */
  const act = async (call: () => Promise<LosslessStatus>, done?: string) => {
    if (busy()) return;
    setBusy(true);
    try {
      setStatus(await call());
      if (done) toast.success(done);
    } catch {
      toast.error(t('settings.losslessFailed'));
    } finally {
      setBusy(false);
      schedule();
    }
  };

  const toggleEnabled = async () => {
    const current = status();
    if (!current) return;
    const next = !current.enabled;
    setStatus({ ...current, enabled: next });
    try {
      await api.setLosslessEnabled(next);
    } catch {
      setStatus({ ...current, enabled: !next });
      toast.error(t('settings.toast.notSaved'));
    }
  };

  const recheck = async () => {
    const ok = await confirmDialog({
      title: t('settings.losslessRecheck'),
      message: t('settings.losslessRecheckConfirm'),
      confirmLabel: t('settings.losslessRunNow'),
    });
    if (!ok) return;
    await act(() => api.runLosslessNow(true), t('settings.losslessRunStarted'));
  };

  const saveJamendo = async () => {
    const value = jamendoClientId().trim();
    if (!value || busy()) return;
    setBusy(true);
    try {
      const result = await api.setJamendoClientId(value);
      setJamendoClientId('');
      await refresh();
      toast.success(
        result.jamendo_configured
          ? t('settings.losslessJamendoSaved')
          : t('settings.losslessJamendoInvalid'),
      );
    } catch {
      toast.error(t('settings.losslessJamendoInvalid'));
    } finally {
      setBusy(false);
    }
  };

  onMount(refresh);
  onCleanup(() => clearTimeout(timer));

  return (
    <SettingsGroup label={t('settings.losslessStatusLabel')} note={t('settings.losslessNote')}>
      <SwitchRow
        label={t('settings.losslessUpgrades')}
        checked={status()?.enabled ?? true}
        onChange={toggleEnabled}
      />

      <ValueRow label={t('settings.losslessState')} value={status() ? activityLabel(status()!) : '—'} />
      <ValueRow label={t('settings.losslessUpgraded')} value={String(count('completed'))} />
      <ValueRow label={t('settings.losslessPending')} value={String(pending())} />
      <ValueRow label={t('settings.losslessNoMatch')} value={String(count('no_match'))} />
      <ValueRow
        label={t('settings.losslessCheckedToday')}
        value={`${status()?.budget?.tracks_examined ?? 0} / ${status()?.budget?.max_tracks ?? 0}`}
      />

      <Show when={!(status()?.identity_verifier_available ?? true)}>
        <ValueRow label={t('settings.losslessVerifier')} value={t('settings.losslessUnavailable')} />
      </Show>

      <ValueRow
        label={t('settings.losslessJamendo')}
        value={jamendoReady() ? t('settings.losslessJamendoReady') : t('settings.losslessJamendoMissing')}
      />
      <InputRow
        label={t('settings.losslessJamendoClientId')}
        hint={t('settings.losslessJamendoHint')}
        value={jamendoClientId()}
        placeholder={jamendoReady() ? '••••••••' : ''}
        type="password"
        autocomplete="off"
        onInput={setJamendoClientId}
      />
      <ActionRow
        label={t('settings.losslessJamendoSave')}
        disabled={busy() || !jamendoClientId().trim()}
        onClick={() => void saveJamendo()}
      />

      <Show
        when={running() || paused()}
        fallback={
          <ActionRow
            label={t('settings.losslessRunNow')}
            hint={t('settings.losslessRunNowHint')}
            disabled={busy()}
            onClick={() => void act(() => api.runLosslessNow(), t('settings.losslessRunStarted'))}
          />
        }
      >
        <Show
          when={paused()}
          fallback={
            <ActionRow
              label={t('settings.losslessPause')}
              hint={t('settings.losslessProcessed', { n: status()?.manual?.processed ?? 0 })}
              disabled={busy()}
              onClick={() => void act(() => api.pauseLossless())}
            />
          }
        >
          <ActionRow
            label={t('settings.losslessResume')}
            hint={t('settings.losslessProcessed', { n: status()?.manual?.processed ?? 0 })}
            disabled={busy()}
            onClick={() => void act(() => api.resumeLossless())}
          />
        </Show>
        <ActionRow
          label={t('settings.losslessCancel')}
          disabled={busy()}
          danger
          onClick={() => void act(() => api.cancelLossless(), t('settings.losslessRunCancelled'))}
        />
      </Show>

      <ActionRow
        label={t('settings.losslessRecheck')}
        hint={t('settings.losslessRecheckHint')}
        disabled={busy()}
        onClick={() => void recheck()}
      />
    </SettingsGroup>
  );
}
