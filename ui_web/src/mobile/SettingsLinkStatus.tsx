import { createEffect, createSignal, on, onCleanup } from 'solid-js';
import { request } from '../lib/http';
import type { LinkReading } from '../lib/linkQuality';
import { LinkStatusView } from '../components/LinkStatusView';

export default function NativeSettingsLinkStatus(props: { identity: () => number; available: () => boolean }) {
  const [reading, setReading] = createSignal<LinkReading | null>(null);
  let epoch = 0;
  createEffect(on(() => [props.identity(), props.available()] as const, ([identity, available]) => {
    const revision = ++epoch, controller = new AbortController(); setReading(null);
    if (available) void request<LinkReading>('/api/playback/link', { signal: controller.signal, timeoutMs: 8000 }).then(value => {
      if (revision !== epoch || identity !== props.identity() || !props.available() || controller.signal.aborted) return;
      if (value.scope !== null && !['local', 'lan', 'tailnet', 'remote'].includes(value.scope)) return;
      if (value.kbps !== null && (!Number.isFinite(value.kbps) || value.kbps <= 0)) return;
      setReading(value);
    }).catch(() => { /* Unknown is a usable diagnostic, not an editable preference. */ });
    onCleanup(() => { epoch++; controller.abort(); });
  }));
  return <LinkStatusView reading={reading()} />;
}
