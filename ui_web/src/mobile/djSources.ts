import type { MenuAction } from '../components/ActionMenu';
import type { ProgramCommand, ProgramState } from '../lib/program/runtime';
import type { Track } from '../types/music';
import { programTrack } from '../lib/program/tracks';
import { isPodcastTrack } from '../lib/track';
import { t } from '../lib/i18n';

/** Collection menus capture an account and programme before changing musical sources. */
export function nativeDjSourceActions(_id: string, label: string, tracks: Track[], state: () => ProgramState | null,
  current: () => boolean, pending: () => boolean, execute: (command: ProgramCommand) => Promise<void>): MenuAction[] {
  const captured = state();
  const music = tracks.filter(track => !isPodcastTrack(track));
  if (!captured?.ready || !music.length) return [];
  const valid = () => current() && !pending() && state()?.generation === captured.generation && state()?.programToken === captured.programToken;
  const requested = music.map(programTrack).filter(track => track !== null);
  const fits = requested.length > 0 && requested.length <= 1000 && JSON.stringify(requested).length <= 65536;
  return [{
    label: t('autoMode.startDj'), disabled: pending() || !fits,
    onSelect: () => {
      if (!valid() || !fits || state()?.queueToken !== captured.queueToken) return;
      void execute({ action: 'djSelection', tracks: requested, label,
        queueToken: captured.queueToken, programToken: captured.programToken }).catch(() => {});
    },
  }];
}
