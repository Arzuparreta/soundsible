import { createSignal, onCleanup, onMount } from 'solid-js';
import { nativeShare, type IncomingTrackEnvelope } from './share';
import { nativeInviteLink } from './inviteLink';

/** An OS invitation is a proposal; reading it never connects or previews a server. */
export function createIncomingInvite() {
  const [selection, setSelection] = createSignal<{ token: string; origin: string; invitationToken: string } | null>(null);
  let disposed = false, revision = 0;
  let remove: (() => Promise<void>) | undefined;
  function receive(value: IncomingTrackEnvelope | null) {
    if (disposed || !value || typeof value.token !== 'string' || !value.token || value.token.length > 64 || typeof value.url !== 'string') return;
    const invitation = nativeInviteLink(value.url);
    setSelection(invitation ? { token: value.token, origin: invitation.origin, invitationToken: invitation.token } : null);
  }
  onMount(() => {
    void nativeShare.addListener('incomingTrack', value => { revision++; receive(value); }).then(listener => {
      if (disposed) { void listener.remove(); return; }
      remove = () => listener.remove();
      const observed = revision;
      void nativeShare.incoming().then(result => { if (!disposed && revision === observed) receive(result.incoming); }).catch(() => {});
    }).catch(() => {});
  });
  onCleanup(() => { disposed = true; void remove?.(); });
  async function dismiss(token = selection()?.token) {
    if (!token) return;
    await nativeShare.dismiss({ token });
    if (!disposed && selection()?.token === token) setSelection(null);
  }
  return { selection, dismiss };
}
