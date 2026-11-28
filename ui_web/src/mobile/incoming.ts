import { createSignal, onCleanup, onMount } from 'solid-js';
import type { TrackShareCapsuleV1 } from '../lib/trackShare';
import { nativeInviteLink } from './inviteLink';
import { incomingTrack } from './incomingTrack';
import { nativeShare, type IncomingTrackEnvelope } from './share';

/** A newer OS intent takes precedence over the pending link read at startup. */
export function createIncomingLinks() {
  let disposed = false;
  let revision = 0;
  let remove: (() => Promise<void>) | undefined;

  function createSelection<T extends { token: string }>() {
    const [selection, setSelection] = createSignal<T | null>(null);
    async function dismiss(token = selection()?.token) {
      if (!token) return;
      await nativeShare.dismiss({ token });
      if (!disposed && selection()?.token === token) setSelection(null);
    }
    return [{ selection, dismiss }, setSelection] as const;
  }

  const [song, setSong] = createSelection<{ token: string; capsule: TrackShareCapsuleV1 }>();
  const [invitation, setInvitation] = createSelection<{ token: string; origin: string; invitationToken: string }>();

  function receive(value: IncomingTrackEnvelope | null) {
    if (disposed || !value || typeof value.token !== 'string' || !value.token || value.token.length > 64 || typeof value.url !== 'string') return;
    const { token, url } = value;
    const invite = nativeInviteLink(url);
    if (invite) {
      setSong(null);
      setInvitation({ token, origin: invite.origin, invitationToken: invite.token });
      return;
    }
    setInvitation(null);
    const capsule = incomingTrack(url);
    if (capsule) setSong({ token, capsule });
    else void nativeShare.dismiss({ token }).catch(() => {});
  }

  onMount(() => {
    void nativeShare.addListener('incomingTrack', value => { revision++; receive(value); }).then(listener => {
      if (disposed) { void listener.remove(); return; }
      remove = () => listener.remove();
      const observed = revision;
      void nativeShare.incoming().then(result => { if (observed === revision) receive(result.incoming); }).catch(() => {});
    }).catch(() => {});
  });
  onCleanup(() => { disposed = true; void remove?.(); });
  return { song, invitation };
}
