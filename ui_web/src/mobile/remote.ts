import { onCleanup } from 'solid-js';
import type { PluginListenerHandle } from '@capacitor/core';
import { t } from '../lib/i18n';
import { createRemoteControl, type RemoteLink } from '../lib/remoteControl';
import { nativeDevices, type NativeDeviceState } from './devices';

/** Controlling another device from the Android app: lib/remoteControl, with this
 * phone as the device and the playback service's account socket as the watch
 * link (the WebView has no socket of its own). Must be created inside a component. */
export function createNativeRemote(props: { generation: () => number; device: () => NativeDeviceState | null }) {
  const control = createRemoteControl({
    selfId: () => props.device()?.device_id ?? null,
    selfName: () => props.device()?.device_name || t('deviceSheet.fallbackDevice'),
  });
  const link: RemoteLink = {
    watch: (id, ack) => {
      const generation = props.generation();
      nativeDevices.deviceWatch({ generation, device_id: id }).then(
        answer => ack(generation === props.generation() ? answer : null),
        // Not connected yet: the service watches it once its socket is up and forwards the state.
        () => ack(null),
      );
    },
    unwatch: () => void nativeDevices.deviceWatch({ generation: props.generation(), device_id: null }).catch(() => {}),
  };
  control.attach(link);
  let alive = true;
  const handles: PluginListenerHandle[] = [];
  const keep = (handle: PluginListenerHandle) => { if (alive) handles.push(handle); else void handle.remove(); };
  void nativeDevices.addListener('device_updated', event => {
    if (event.generation === props.generation()) control.deviceUpdated(event.device, event.server_now_ms);
  }).then(keep).catch(() => {});
  void nativeDevices.addListener('device_state', event => {
    if (event.generation === props.generation()) control.applyDeviceState(event);
  }).then(keep).catch(() => {});
  onCleanup(() => { alive = false; for (const handle of handles) void handle.remove(); control.reset(); });
  return {
    control,
    /** What the device button says: where devices are, or the controlled device and whether it answers. */
    label: () => !control.target() ? t('settings.devices')
      : t(control.unreachable() ? 'deviceSheet.offline' : 'deviceSheet.playingOnDevice', { device: control.controlledName() }),
    /** A new account (or none): nothing of the old one is controlled. */
    reset() { control.reset(); control.attach(link); },
  };
}
