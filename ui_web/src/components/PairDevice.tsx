import { createSignal, For, Show, onMount, onCleanup } from 'solid-js';
import QRCode from '../lib/vendor/qrcode.esm.js';
import { openOverlay } from '../lib/overlay';
import { api, type PairingSession, type PairedDevice } from '../lib/api';
import { toast } from '../lib/toast';
import { confirmDialog } from '../lib/confirm';
import styles from './PairDevice.module.css';

const POLL_MS = 2000;
const ACTIVE = new Set(['pending', 'claimed']);

function statusLabel(s: PairingSession | null): string {
  switch (s?.status) {
    case 'pending':
      return 'Esperando a que el dispositivo escanee…';
    case 'claimed':
      return 'Vinculando dispositivo…';
    case 'completed':
      return '¡Dispositivo vinculado!';
    case 'cancelled':
      return 'Sesión cancelada';
    case 'expired':
      return 'El código ha caducado';
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
        setError('No se pudo iniciar el emparejamiento. Abre el reproductor en el equipo anfitrión.');
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
            toast.success(`Vinculado: ${rec.device_name ?? 'dispositivo'}`);
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
        toast.success('Código copiado');
      } catch {
        /* clipboard blocked */
      }
    };

    return (
      <div class={styles.pair}>
        <header class={styles.head}>
          <span class={styles.eyebrow}>Vincular dispositivo</span>
          <span class={styles.title}>Escanea y conecta</span>
        </header>

        <Show
          when={!error()}
          fallback={<p class={styles.error}>{error()}</p>}
        >
          <Show when={session()} fallback={<p class={styles.status}>Generando código…</p>}>
            <div class={styles.body}>
              <div class={styles.qrWrap}>
                <Show when={qrSrc()} fallback={<div class={styles.qrSkeleton} />}>
                  <img class={styles.qr} src={qrSrc()} alt="Código QR de emparejamiento" width="240" height="240" />
                </Show>
              </div>

              <div class={styles.info}>
                <div class={styles.codeBlock}>
                  <span class={styles.codeLabel}>Código</span>
                  <span class={styles.code}>{session()!.code}</span>
                </div>
                <p
                  class={styles.status}
                  classList={{ [styles.done]: session()!.status === 'completed' }}
                >
                  {statusLabel(session())}
                </p>
                <Show when={session()!.connect?.claim_url} fallback={
                  <p class={styles.note}>El acceso por LAN no está disponible: introduce el código manualmente en el otro dispositivo.</p>
                }>
                  <a class={styles.link} href={session()!.connect!.claim_url!} target="_blank" rel="noopener">
                    {session()!.connect!.player_url ?? session()!.connect!.claim_url}
                  </a>
                  <p class={styles.note}>Si no puedes escanear, abre el enlace e introduce el código.</p>
                </Show>
              </div>
            </div>
          </Show>
        </Show>

        <footer class={styles.actions}>
          <Show when={session() && session()!.status !== 'completed'}>
            <button class={styles.btn} type="button" onClick={copyCode}>
              Copiar código
            </button>
          </Show>
          <button class={styles.btn} type="button" onClick={cancel}>
            {session()?.status === 'completed' ? 'Cerrar' : 'Cancelar'}
          </button>
        </footer>
      </div>
    );
  });
}

function fmtWhen(value?: string | null): string {
  if (!value) return 'Nunca';
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
      title: 'Revocar dispositivo',
      message: `Se revocará el acceso de "${d.name ?? 'este dispositivo'}". Tendrá que volver a vincularse.`,
      confirmLabel: 'Revocar',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.revokePairedDevice(d.token_id);
      toast.success('Dispositivo revocado');
      await refresh();
    } catch {
      toast.error('No se pudo revocar');
    }
  };

  return (
    <>
      <Show when={!loading()} fallback={<p class={styles.empty}>Cargando…</p>}>
        <Show when={devices().length > 0} fallback={<p class={styles.empty}>Aún no hay dispositivos vinculados.</p>}>
          <For each={devices()}>
            {(d) => (
              <div class={styles.deviceRow}>
                <div class={styles.deviceMeta}>
                  <span class={styles.deviceName}>{d.name ?? 'Dispositivo vinculado'}</span>
                  <span class={styles.deviceSub}>
                    {(d.device_type ?? 'phone')} · usado: {fmtWhen(d.last_used_at)}
                  </span>
                </div>
                <button class={styles.revoke} type="button" onClick={() => revoke(d)}>
                  Revocar
                </button>
              </div>
            )}
          </For>
        </Show>
      </Show>
      <button class={styles.pairBtn} type="button" onClick={() => openPairDevice(refresh)}>
        Vincular dispositivo nuevo
      </button>
    </>
  );
}
