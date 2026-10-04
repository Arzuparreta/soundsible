import type { MenuAction } from '../components/ActionMenu';
import { confirmDialog } from '../lib/confirm';
import { t } from '../lib/i18n';
import { toast } from '../lib/toast';
import type { Track } from '../types/music';
import type { createNativeFileDeletion } from './fileDeletion';

export function nativeFileDeletionAction(track: Track, deletion: ReturnType<typeof createNativeFileDeletion>,
  current: () => boolean): MenuAction {
  async function confirm() {
    if (!current() || deletion.busy(track.id)) return;
    const accepted = await confirmDialog({ title: t('trackActions.deleteTitle'),
      message: t('trackActions.deleteMsg', { title: track.title }),
      confirmLabel: t('trackActions.deleteConfirm'), danger: true }, current);
    if (!accepted || !current()) return;
    try {
      if (await deletion.remove(track) && current()) toast.success(t('toast.trackDeleted'));
    } catch { if (current()) toast.error(t('toast.deleteFailed')); }
  }
  return { label: t('trackActions.deleteFromLibrary'), danger: true,
    disabled: !current() || deletion.busy(track.id), onSelect: () => { void confirm(); } };
}
