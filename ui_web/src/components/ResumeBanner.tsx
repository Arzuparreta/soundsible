import { resumeState, actions } from '../stores';
import { ResumeBannerView } from './ResumeBannerView';

/**
 * Top banner offering to pick up playback that's active on another device.
 * Driven by the `resumeState` signal (set once on boot by actions.checkResume).
 */
export function ResumeBanner() {
  return <ResumeBannerView offer={resumeState()} onResume={() => actions.resumeHere()} onDismiss={() => actions.dismissResume()} />;
}
