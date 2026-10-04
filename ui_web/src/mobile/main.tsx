import { render } from 'solid-js/web';
import AndroidStart from './AndroidStart';
import { nativeBuildInfo } from './platform';
import { initLocale } from '../lib/i18n';
import { createNativeAppearance } from './appearance';
import '../boot/fonts';
import '../styles/tokens.css';
import '../styles/app.css';

// Evidence for the native instrumentation smoke; never includes account data.
export const nativeAppearance = createNativeAppearance();
async function start() {
  await Promise.all([initLocale(), window.__SOUNDSIBLE_BOOT__?.stylesReady]);
  const info = await nativeBuildInfo();
  const root = document.getElementById('app');
  if (!root) throw new Error('#app mount point missing');
  root.dataset.nativeApplication = info.applicationId;
  root.dataset.nativeVersion = info.version;
  root.dataset.nativeBuild = info.build;
  root.dataset.nativeRevision = __ANDROID_SOURCE_REVISION__;
  render(() => <AndroidStart appearance={nativeAppearance} />, root);
}
void start().catch(() => window.__SOUNDSIBLE_BOOT__?.fail());
