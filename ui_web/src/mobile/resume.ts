import { createEffect, createSignal, on, onCleanup } from 'solid-js';
import { api, type RemotePlaybackState } from '../lib/api';
import { request } from '../lib/http';
import { t } from '../lib/i18n';
import { remoteCommandMessage } from '../lib/remotePlayback';

const SUPPRESS = 'resume_suppress_until', COOLDOWN = 'resume_cooldown_at';
const read = (key: string) => { try { return Number(localStorage.getItem(key)) || 0; } catch { return 0; } };

/**
 * Offers, once per account, to continue what another device was playing — the web's resume banner.
 * Accepting asks Core to transfer that session to this phone, so the other device stops only once
 * this phone is playing, and the session arrives through the same transfer path as Devices.
 */
export function createNativeResume(props: {
  identity: () => number; available: () => boolean; idle: () => boolean; self: () => string | null;
}, now = () => Date.now()) {
  const [offer, setOffer] = createSignal<RemotePlaybackState | null>(null);
  const [busy, setBusy] = createSignal(false);
  let checked = -1;
  // One question per account: it lives until the account changes, not until this phone's state next ticks.
  let controller: AbortController | undefined;
  onCleanup(() => controller?.abort());
  createEffect(on(() => [props.identity(), props.available(), props.idle(), props.self()] as const, ([identity, available, idle, self]) => {
    if (identity !== checked) { setOffer(null); controller?.abort(); }
    if (!available || !idle || !self || checked === identity) return;
    checked = identity;
    controller = new AbortController();
    const signal = controller.signal;
    void request<RemotePlaybackState | undefined>(`/api/playback/state?exclude_device=${encodeURIComponent(self)}`, { signal, timeoutMs: 8000 }).then(remote => {
      if (signal.aborted || identity !== props.identity() || !props.idle()) return;
      if (!remote?.track_id || !remote.device_id || remote.device_id === self) return;
      const updated = Number(remote.updated_at) || 0;
      if (updated && now() / 1000 - updated > 24 * 3600) return; // stale, as on the web
      // Honour a recent "No" unless the other device has played since.
      if (now() < read(SUPPRESS) && updated * 1000 <= read(COOLDOWN)) return;
      setOffer(remote);
    }).catch(() => {});
  }));
  // Starting anything here answers the question.
  createEffect(on(props.idle, idle => { if (!idle) setOffer(null); }, { defer: true }));
  async function resume(): Promise<string | null> {
    const remote = offer(), self = props.self(), identity = props.identity();
    if (!remote?.device_id || !self || busy()) return null;
    const name = remote.device_name ?? t('deviceSheet.fallbackDevice');
    setBusy(true);
    try {
      const answer = await api.transfer(remote.device_id, self);
      if (answer.status !== 'applied') return remoteCommandMessage(answer, name);
      if (identity === props.identity()) setOffer(null);
      return null;
    } catch {
      return remoteCommandMessage(null, name);
    } finally { setBusy(false); }
  }
  function dismiss() {
    setOffer(null);
    try { localStorage.setItem(SUPPRESS, String(now() + 30 * 60 * 1000)); localStorage.setItem(COOLDOWN, String(now())); } catch { /* best effort */ }
  }
  return { offer, busy, resume, dismiss };
}
