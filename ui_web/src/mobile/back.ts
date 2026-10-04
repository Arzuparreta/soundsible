import { App } from '@capacitor/app';
import { dismissContextMenu } from '../lib/contextMenu';
import { dismissTopOverlay } from '../lib/overlay';
import { dispatchNavigationBack } from './backNavigation';

/** OS pickers/keyboard own their Back; this listener handles the app underneath. */
export function handleNativeBack(): boolean {
  return dismissContextMenu() || dismissTopOverlay() || dispatchNavigationBack();
}
export function attachNativeBack(onFailure: () => void): () => void {
  let active = true;
  const registration = App.addListener('backButton', () => {
    if (!active || handleNativeBack()) return;
    void App.minimizeApp().catch(() => { if (active) onFailure(); });
  });
  void registration.catch(() => { if (active) onFailure(); });
  return () => {
    active = false;
    void registration.then(listener => listener.remove()).catch(() => {});
  };
}
