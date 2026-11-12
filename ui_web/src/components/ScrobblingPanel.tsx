import { createScrobbling } from '../lib/scrobbling';
import { toast } from '../lib/toast';
import { ScrobblingView } from './ScrobblingView';
import { SettingsLoad } from './SettingsLoad';

/**
 * Settings → Scrobbling. The engine does the scrobbling, from what every
 * client already reports about playback, so this screen only connects the
 * services an account wants its plays sent to.
 */
export function ScrobblingPanel() {
  const scrobbling = createScrobbling({ onError: toast.error });
  return (
    <SettingsLoad load={scrobbling.load}>
      <ScrobblingView
        status={scrobbling.status()}
        busy={scrobbling.busy()}
        lastfmUrl={scrobbling.lastfmUrl()}
        onConnect={(service) => void scrobbling.connect(service)}
        onCustomListenBrainz={() => void scrobbling.connectListenBrainz(true)}
        onFinishLastfm={() => void scrobbling.finishLastfm()}
        onToggle={(service) => void scrobbling.toggle(service)}
        onRetry={(service) => void scrobbling.retry(service)}
        onDisconnect={(service) => void scrobbling.disconnect(service)}
        onLastfmApp={() => void scrobbling.setLastfmApp()}
        onRemoveLastfmApp={() => void scrobbling.removeLastfmApp()}
      />
    </SettingsLoad>
  );
}
