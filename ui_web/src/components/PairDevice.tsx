import { createSignal, For, Show, onMount, onCleanup } from 'solid-js';
import QRCode from '../lib/vendor/qrcode.esm.js';
import { openOverlay } from '../lib/overlay';
import { api, type PairingSession, type PairedDevice } from '../lib/api';
import { toast } from '../lib/toast';
import { confirmDialog } from '../lib/confirm';
import { t } from '../lib/i18n';
import styles from './PairDevice.module.css';

const POLL_MS = 2000;
const ACTIVE = new Set(['pending', 'claimed']);

function statusLabel(s: PairingSession | null): string {
  switch (s?.status) {
    case 'pending':
      return t('pairDevice.statusPending');
    case 'claimed':
      return t('pairDevice.statusClaimed');
    case 'completed':
      return t('pairDevice.statusCompleted');
    case 'cancelled':
      return t('pairDevice.statusCancelled');
    case 'expired':
      return t('pairDevice.statusExpired');
    default:
      return '';
  }
}

/**
 * Owner-side pairing sheet: opens an auto-confirming session, shows a QR + code
 * for a phone to scan/claim, and polls until the engine reports it paired.
 * Mirrors the legacy desktop pairing flow against the same /api/pairing/* routes.
 */
function openPairDevice(onPaired: () => void): void {
  openOverlay((close) => {
    const [session, setSession] = createSignal<PairingSession | null>(null);
    const [qrSrc, setQrSrc] = createSignal('');
    const [error, setError] = createSignal('');
    let poll: number | undefined;
    let sessionId: string | undefined;
    let lastStatus: string | undefined;

    const renderQr = (text?: string) => {
      if (!text) return;
      QRCode.toDataURL(text, {
        width: 240,
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#0b1220', light: '#ffffff' },
      })
        .then(setQrSrc)
        .catch(() => {});
    };

    const stopPoll = () => {
      if (poll) {
        clearInterval(poll);
        poll = undefined;
      }
    };

    onMount(async () => {
      let s: PairingSession;
      try {
        s = await api.createPairingSession();
      } catch {
        setError(t('pairDevice.initError'));
        return;
      }
      sessionId = s.session_id;
      lastStatus = s.status;
      setSession(s);
      renderQr(s.connect?.qr_text);

      poll = window.setInterval(async () => {
        if (!sessionId) return;
        try {
          const { sessions } = await api.listPairingSessions();
          const rec = (sessions ?? []).find((e) => e.session_id === sessionId);
          if (!rec) return;
          setSession(rec);
          if (rec.status === lastStatus) return;
          lastStatus = rec.status;
          if (rec.status === 'completed') {
            stopPoll();
            toast.success(t('pairDevice.linkedToast', { device: rec.device_name ?? t('pairDevice.fallbackDevice') }));
            onPaired();
          } else if (rec.status === 'cancelled' || rec.status === 'expired') {
            stopPoll();
          }
        } catch {
          /* transient; keep polling */
        }
      }, POLL_MS);
    });

    onCleanup(() => {
      stopPoll();
      if (sessionId && lastStatus && ACTIVE.has(lastStatus)) {
        void api.setPairingDisplay(sessionId, false).catch(() => {});
      }
    });

    const cancel = async () => {
      if (sessionId && lastStatus && ACTIVE.has(lastStatus)) {
        void api.cancelPairingSession(sessionId).catch(() => {});
      }
      close();
    };

    const copyCode = async () => {
      const code = session()?.code;
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code);
        toast.success(t('pairDevice.codeCopied'));
      } catch {
        /* clipboard blocked */
      }
    };

    return (
      <div class={styles.pair}>
        <header class={styles.head}>
          <span class={styles.eyebrow}>{t('pairDevice.eyebrow')}</span>
          <span class={styles.title}>{t('pairDevice.pairTitle')}</span>
        </header>

        <Show
          when={!error()}
          fallback={<p class={styles.error}>{error()}</p>}
        >
          <Show when={session()} fallback={<p class={styles.status}>{t('pairDevice.generating')}</p>}>
            <div class={styles.body}>
              <div class={styles.qrWrap}>
                <Show when={qrSrc()} fallback={<div class={styles.qrSkeleton} />}>
                  <img class={styles.qr} src={qrSrc()} alt={t('pairDevice.qrAlt')} width="240" height="240" />
                </Show>
              </div>

              <div class={styles.info}>
                <div class={styles.codeBlock}>
                  <span class={styles.codeLabel}>{t('pairDevice.codeLabel')}</span>
                  <span class={styles.code}>{session()!.code}</span>
                </div>
                <p
                  class={styles.status}
                  classList={{ [styles.done]: session()!.status === 'completed' }}
                >
                  {statusLabel(session())}
                </p>
                <Show when={session()!.connect?.claim_url} fallback={
                  <p class={styles.note}>{t('pairDevice.noteNoClaimUrl')}</p>
                }>
                  <a class={styles.link} href={session()!.connect!.claim_url!} target="_blank" rel="noopener">
                    {session()!.connect!.player_url ?? session()!.connect!.claim_url}
                  </a>
                  <p class={styles.note}>{t('pairDevice.noteWithClaim')}</p>
                </Show>
              </div>
            </div>
          </Show>
        </Show>

        <footer class={styles.actions}>
          <Show when={session() && session()!.status !== 'completed'}>
            <button class={styles.btn} type="button" onClick={copyCode}>
              {t('pairDevice.copy')}
            </button>
          </Show>
          <button class={styles.btn} type="button" onClick={cancel}>
            {session()?.status === 'completed' ? t('pairDevice.close') : t('pairDevice.cancel')}
          </button>
        </footer>
      </div>
    );
  });
}

function fmtWhen(value?: string | null): string {
  if (!value) return t('pairDevice.never');
  const d = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

/** Settings panel: paired devices list with revoke + a button to pair a new one. */
export function PairedDevicesPanel() {
  const [devices, setDevices] = createSignal<PairedDevice[]>([]);
  const [loading, setLoading] = createSignal(true);

  const refresh = async () => {
    try {
      const { devices } = await api.listPairedDevices();
      setDevices(devices ?? []);
    } catch {
      /* leave current list */
    } finally {
      setLoading(false);
    }
  };
  onMount(refresh);

  const revoke = async (d: PairedDevice) => {
    const ok = await confirmDialog({
      title: t('pairDevice.revokeTitle'),
      message: t('pairDevice.revokeMsg', { name: d.name ?? t('pairDevice.revokeMsgFallback') }),
      confirmLabel: t('pairDevice.revokeConfirm'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.revokePairedDevice(d.token_id);
      toast.success(t('pairDevice.revoked'));
      await refresh();
    } catch {
      toast.error(t('pairDevice.revokeFailed'));
    }
  };

  return (
    <>
      <Show when={!loading()} fallback={<p class={styles.empty}>{t('pairDevice.loading')}</p>}>
        <Show when={devices().length > 0} fallback={<p class={styles.empty}>{t('pairDevice.empty')}</p>}>
          <For each={devices()}>
            {(d) => (
              <div class={styles.deviceRow}>
                <div class={styles.deviceMeta}>
                  <span class={styles.deviceName}>{d.name ?? t('pairDevice.pairedFallback')}</span>
                  <span class={styles.deviceSub}>
                    {(d.device_type ?? t('pairDevice.phoneType'))} · {t('pairDevice.lastUsed', { when: fmtWhen(d.last_used_at) })}
                  </span>
                </div>
                <button class={styles.revoke} type="button" onClick={() => revoke(d)}>
                  {t('pairDevice.revoke')}
                </button>
              </div>
            )}
          </For>
        </Show>
      </Show>
      <button class={styles.pairBtn} type="button" onClick={() => openPairDevice(refresh)}>
        {t('pairDevice.pairNew')}
      </button>
    </>
  );
}
