import { createSignal, onCleanup, onMount } from 'solid-js';
import { nativeInviteLink } from './inviteLink';
import { incomingTrack } from './incomingTrack';
import { nativeShare, type IncomingTrackEnvelope } from './share';
import type { TrackShareCapsuleV1 } from '../lib/trackShare';

/** Preserve explicit incoming selection across cold/recreated UI; a new intent wins over a slow initial read. */
export function createIncomingTrack() {
  const [selection, setSelection] = createSignal<{ token: string; capsule: TrackShareCapsuleV1 } | null>(null);
  let disposed = false, revision = 0;
  let remove: (() => Promise<void>) | undefined;
  function receive(value: IncomingTrackEnvelope | null) {
    if (disposed || !value || typeof value.token !== 'string' || !value.token || value.token.length > 64 || typeof value.url !== 'string') return;
    if (nativeInviteLink(value.url)) { setSelection(null); return; }
    const capsule = incomingTrack(value.url);
    if (!capsule) { void nativeShare.dismiss({ token: value.token }).catch(() => {}); return; }
    setSelection({ token: value.token, capsule });
  }
  onMount(() => {
    void nativeShare.addListener('incomingTrack', value => { revision++; receive(value); }).then(listener => {
      if (disposed) { void listener.remove(); return; }
      remove = () => listener.remove();
      const observed = revision;
      void nativeShare.incoming().then(result => { if (!disposed && observed === revision) receive(result.incoming); }).catch(() => {});
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
