import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';

export interface NativeBuildInfo {
  platform: 'android';
  applicationId: string;
  version: string;
  build: string;
}

/** Native bridge probe; no credentials or pretend playback capabilities. */
export async function nativeBuildInfo(): Promise<NativeBuildInfo> {
  if (Capacitor.getPlatform() !== 'android') throw new Error('Android runtime required');
  const info = await App.getInfo();
  return { platform: 'android', applicationId: info.id, version: info.version, build: info.build };
}
