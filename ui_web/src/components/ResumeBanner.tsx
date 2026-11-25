import { lazy, Show } from 'solid-js';
import { resumeState, actions } from '../stores';
import { player } from '../stores/player';

const ResumeBannerView = lazy(() => import('./ResumeBannerView')
  .then(module => ({ default: module.ResumeBannerView })));

/**
 * Top banner offering to pick up playback that's active on another device.
 * Driven by the `resumeState` signal (set once on boot by actions.checkResume).
 * Not while another device is controlled: the device sheet offers "Listen here".
 */
export function ResumeBanner() {
  return (
    <Show when={!player().remote && resumeState()}>
      {offer => <ResumeBannerView offer={offer()} onResume={() => actions.resumeHere()} onDismiss={() => actions.dismissResume()} />}
    </Show>
  );
}
