import type { MenuAction } from '../components/ActionMenu';
import type { ProgramCommand, ProgramState } from '../lib/program/runtime';
import type { Track } from '../types/music';
import { isPodcastTrack } from '../lib/track';
import { t } from '../lib/i18n';

/** Collection menus capture an account and programme before changing musical sources. */
export function nativeDjSourceActions(id: string, label: string, tracks: Track[], state: () => ProgramState | null,
  current: () => boolean, pending: () => boolean, execute: (command: ProgramCommand) => Promise<void>): MenuAction[] {
  const captured = state();
  const music = tracks.filter(track => !isPodcastTrack(track));
  if (!captured?.ready || !music.length) return [];
  const valid = () => current() && !pending() && state()?.generation === captured.generation && state()?.programToken === captured.programToken;
  const source = { id, label, tracks: music.map(track => ({ ...track })), activation: 0 };
  const active = captured.dj?.active === true;
  const sources = captured.dj?.sources ?? [];
  const included = sources.some(item => item.id === id);
  const next = included ? sources.filter(item => item.id !== id) : [...sources, source];
  const payload = active ? next : [source];
  return [{
    label: t(active ? (included ? 'autoMode.source.remove' : 'autoMode.source.add') : 'autoMode.startDj', { title: label }),
    disabled: pending() || payload.length > 64 || JSON.stringify(payload).length > 65536,
    onSelect: () => {
      if (!valid() || payload.length > 64 || JSON.stringify(payload).length > 65536) return;
      void execute(active && captured.programToken
        ? { action: 'djSettings', programToken: captured.programToken, sources: next }
        : { action: 'dj', profile: 'adaptive', fromCurrent: false, queueToken: captured.queueToken, sources: [source] }).catch(() => {});
    },
  }];
}
