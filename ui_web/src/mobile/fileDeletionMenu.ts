import type { MenuAction } from '../components/ActionMenu';
import { confirmDialog } from '../lib/confirm';
import { collectionRemoval } from '../lib/collectionRemoval';
import { t } from '../lib/i18n';
import { toast } from '../lib/toast';
import type { Track } from '../types/music';
import type { createNativeFileDeletion } from './fileDeletion';

export function nativeFileDeletionAction(track: Track, deletion: ReturnType<typeof createNativeFileDeletion>,
  current: () => boolean, keepSaved = false): MenuAction {
  const options = collectionRemoval(track, keepSaved);
  async function confirm() {
    if (!current() || deletion.busy(track.id)) return;
    const accepted = await confirmDialog(options, current);
    if (!accepted || !current()) return;
    try {
      if (await deletion.remove(track, keepSaved) && current()) {
        toast.success(t(keepSaved ? 'toast.downloadRemoved' : 'toast.trackDeleted'));
      }
    } catch { if (current()) toast.error(t('toast.deleteFailed')); }
  }
  return { label: options.label, danger: options.danger,
    disabled: !current() || deletion.busy(track.id), onSelect: () => { void confirm(); } };
}
