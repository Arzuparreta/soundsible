import { createSignal, onCleanup, Show } from 'solid-js';
import { actions } from '../stores';
import { canConfigurePlaybackDiagnostics, resetDiagnosticRetirement } from '../lib/audio';
import { diagnosticStatus, playbackDiagnosticExport, recordPlaybackDiagnostic, startPlaybackDiagnostics,
  stopPlaybackDiagnostics, type DiagnosticSetup, type RetirementVariant } from '../lib/playbackDiagnostics';
import { t } from '../lib/i18n';
import { ActionRow, InputRow, SelectRow, SettingsGroup, ValueRow } from './SettingsRows';

export function PlaybackDiagnostics() {
  const [status, setStatus] = createSignal(diagnosticStatus());
  const [ready, setReady] = createSignal(canConfigurePlaybackDiagnostics());
  const [variant, setVariant] = createSignal<RetirementVariant>('reference');
  const [ios, setIos] = createSignal('');
  const [connection, setConnection] = createSignal<DiagnosticSetup['connection']>('bluetooth');
  const refresh = () => { setStatus(diagnosticStatus()); setReady(canConfigurePlaybackDiagnostics()); };
  const timer = setInterval(refresh, 1000);
  onCleanup(() => clearInterval(timer));
  const start = () => {
    if (!canConfigurePlaybackDiagnostics() || !/^\d+(?:\.\d+){0,3}$/.test(ios().trim())) return;
    startPlaybackDiagnostics({ variant: variant(), ios: ios(), connection: connection() });
    resetDiagnosticRetirement();
    refresh();
  };
  const stop = () => {
    actions.pausePlayback('ui');
    stopPlaybackDiagnostics();
    resetDiagnosticRetirement();
    refresh();
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([playbackDiagnosticExport()], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `soundsible-playback-${status().setup?.id ?? 'capture'}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  return (
    <SettingsGroup label={t('playbackDiagnostic.title')} note={t('playbackDiagnostic.note')}>
      <Show when={!status().active} fallback={
        <>
          <ValueRow label={t('playbackDiagnostic.variant')} value={t(`playbackDiagnostic.${status().setup!.variant}`)} />
          <ActionRow label={t('playbackDiagnostic.failure')} onClick={() => { recordPlaybackDiagnostic('human.failure_observed'); refresh(); }} />
          <ActionRow label={t('playbackDiagnostic.volumeFailure')} onClick={() => { recordPlaybackDiagnostic('human.volume_failed'); refresh(); }} />
          <ActionRow label={t('playbackDiagnostic.recovered')} onClick={() => { recordPlaybackDiagnostic('human.recovered'); refresh(); }} />
          <ActionRow label={t('playbackDiagnostic.stop')} onClick={stop} />
        </>
      }>
        <SelectRow label={t('playbackDiagnostic.variant')} value={variant()} onChange={(v) => setVariant(v as RetirementVariant)}>
          <option value="reference">{t('playbackDiagnostic.reference')}</option>
          <option value="delayed">{t('playbackDiagnostic.delayed')}</option>
          <option value="excluded">{t('playbackDiagnostic.excluded')}</option>
        </SelectRow>
        <InputRow label={t('playbackDiagnostic.ios')} value={ios()} onInput={setIos} />
        <SelectRow label={t('playbackDiagnostic.connection')} value={connection()} onChange={(v) => setConnection(v as DiagnosticSetup['connection'])}>
          <option value="bluetooth">Bluetooth</option>
          <option value="carplay">CarPlay</option>
          <option value="other">{t('playbackDiagnostic.other')}</option>
        </SelectRow>
        <ActionRow label={t('playbackDiagnostic.start')} hint={t('playbackDiagnostic.startHint')} onClick={start}
          disabled={!ready() || !/^\d+(?:\.\d+){0,3}$/.test(ios().trim())} />
      </Show>
      <Show when={status().setup}>
        <ValueRow label={t('playbackDiagnostic.events')} value={`${status().retained} / ${status().dropped}`} />
        <ActionRow label={t('playbackDiagnostic.export')} onClick={download} />
      </Show>
    </SettingsGroup>
  );
}
