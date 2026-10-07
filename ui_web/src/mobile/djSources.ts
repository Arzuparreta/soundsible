import type { MenuAction } from '../components/ActionMenu';
import type { ProgramCommand, ProgramState } from '../lib/program/runtime';
import type { Track } from '../types/music';
import { programTrack } from '../lib/program/tracks';
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
  const only = sources.length === 1 && included;
  const fits = (value: unknown[]) => value.length <= 64 && JSON.stringify(value).length <= 65536;
  const requested = music.map(programTrack).filter(track => track !== null);
  const requestFits = requested.length > 0 && captured.items.length + requested.length <= 1000 && JSON.stringify(requested).length <= 262144;
  return [
    ...(active && captured.programToken ? [{
      label: t('musicExplorer.requestAll'), disabled: pending() || !requestFits,
      onSelect: () => {
        const latest = state();
        if (!valid() || !requestFits || latest?.queueToken !== captured.queueToken) return;
        void execute({ action: 'djRequest', programToken: captured.programToken!, queueToken: captured.queueToken, tracks: requested }).catch(() => {});
      },
    }] : []),
    // The web's primary DJ action on a collection: the session moves onto it, as one source, at once.
    ...(active && captured.programToken && !only ? [{
      label: t('musicExplorer.change'), disabled: pending() || !fits([source]),
      onSelect: () => {
        if (!valid() || !fits([source])) return;
        void execute({ action: 'djSettings', programToken: captured.programToken!, resetRequestGroups: true, sources: [source] }).catch(() => {});
      },
    }] : []),
    {
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
