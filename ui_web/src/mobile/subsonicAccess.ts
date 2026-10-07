import { createEffect, createSignal, on, onCleanup } from 'solid-js';
import { request } from '../lib/http';
import { confirmDialog } from '../lib/confirm';
import { copyText } from '../lib/clipboard';
import { t } from '../lib/i18n';
import type { SubsonicAccess } from '../lib/api';

/** One-time credentials never enter storage, snapshots, diagnostics or another account's UI. */
export function createNativeSubsonicAccess(props: {
  identity: () => number; accountId: () => string; username: () => string; origin: () => string; available: () => boolean;
}, confirm = confirmDialog, copy: (value: string, sensitive: boolean) => Promise<boolean> = value => copyText(value)) {
  const [access, setAccess] = createSignal<SubsonicAccess | null>(null), [password, setPassword] = createSignal('');
  const [loading, setLoading] = createSignal(false), [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal(''), [copied, setCopied] = createSignal(false);
  let epoch = 0, disposed = false;
  let scope: { signal: AbortSignal; current: () => boolean; username: string; origin: string } | undefined;
  function verify(value: SubsonicAccess, username: string) {
    if (!value || value.username !== username || typeof value.configured !== 'boolean' ||
      [value.created_at, value.last_used_at, value.last_client].some(field => field !== null && typeof field !== 'string')) throw new Error('Missing Subsonic confirmation');
    // Construct the public status explicitly; a password belongs only to its separate temporary signal.
    return { username: value.username, configured: value.configured, created_at: value.created_at, last_used_at: value.last_used_at, last_client: value.last_client };
  }
  async function load() {
    const owner = scope; if (!owner?.current() || loading() || busy()) return;
    setLoading(true); setError(''); setPassword(''); setCopied(false);
    try {
      const value = await request<SubsonicAccess>('/api/auth/subsonic', { signal: owner.signal });
      if (owner.current()) setAccess(verify(value, owner.username));
    } catch { if (owner.current()) { setAccess(null); setError(t('common.loadFailed')); } }
    finally { if (owner.current()) setLoading(false); }
  }
  createEffect(on(() => [props.identity(), props.accountId(), props.username(), props.origin(), props.available()] as const,
    ([identity, account, username, origin]) => {
      const revision = ++epoch, controller = new AbortController();
      setAccess(null); setPassword(''); setLoading(false); setBusy(false); setError(''); setCopied(false);
      scope = { signal: controller.signal, username, origin,
        current: () => !disposed && revision === epoch && identity === props.identity() && account === props.accountId() && username === props.username() && origin === props.origin() && props.available() && !controller.signal.aborted };
      void load(); onCleanup(() => controller.abort());
    }));
  onCleanup(() => { disposed = true; epoch++; setPassword(''); });
  async function mutate(action: 'generate' | 'revoke') {
    const owner = scope, before = access(); if (!owner?.current() || !before || busy() || loading()) return;
    setBusy(true); setError(''); setCopied(false);
    try {
      if (action === 'revoke' || before.configured) {
        const accepted = await confirm(action === 'revoke'
          ? { title: t('subsonic.revokeTitle'), message: t('subsonic.revokeMessage'), confirmLabel: t('subsonic.revoke'), danger: true }
          : { title: t('subsonic.replaceTitle'), message: t('subsonic.replaceMessage'), confirmLabel: t('subsonic.generate') }, owner.current);
        if (!accepted || !owner.current()) return;
      }
      setPassword('');
      const receipt = await request<SubsonicAccess & { password?: string }>('/api/auth/subsonic', { method: action === 'generate' ? 'POST' : 'DELETE', signal: owner.signal });
      if (!owner.current()) return;
      const next = verify(receipt, owner.username);
      if (next.configured !== (action === 'generate')) throw new Error('Subsonic change rejected');
      if (action === 'generate' && (typeof receipt.password !== 'string' || !receipt.password || receipt.password.length > 1024)) throw new Error('Missing one-time credential');
      const stored = verify(await request<SubsonicAccess>('/api/auth/subsonic', { signal: owner.signal }), owner.username);
      if (!owner.current()) return;
      if (stored.configured !== next.configured || stored.created_at !== next.created_at) throw new Error('Subsonic status changed');
      setAccess(stored); if (action === 'generate') setPassword(receipt.password!);
    } catch { if (owner.current()) { setAccess(null); setPassword(''); setError(t('settings.toast.notSaved')); } }
    finally { if (owner.current()) setBusy(false); }
  }
  async function copyValue(sensitive: boolean) {
    const owner = scope; if (!owner?.current() || busy() || loading()) return;
    const value = sensitive ? password() : owner.origin; if (!value) return;
    setCopied(false); setError('');
    try { const ok = await copy(value, sensitive); if (owner.current()) { setCopied(ok); if (!ok) setError(t('subsonic.copyFailed')); } }
    catch { if (owner.current()) setError(t('subsonic.copyFailed')); }
  }
  return { access, password, loading, busy, error, copied, load, generate: () => mutate('generate'), revoke: () => mutate('revoke'),
    copyServer: () => copyValue(false), copyPassword: () => copyValue(true) };
}
