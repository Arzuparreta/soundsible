import { beforeEach, expect, it, vi } from 'vitest';
import { nativeFileDeletionAction } from './fileDeletionMenu';
import { confirmDialog } from '../lib/confirm';
import { toast } from '../lib/toast';
import type { Track } from '../types/music';
vi.mock('../lib/confirm', () => ({ confirmDialog: vi.fn() }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
vi.mock('../lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const track: Track = { id: 'hash', title: 'Song', artist: 'Artist' };
beforeEach(() => vi.resetAllMocks());
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
it('cancel leaves the acquired file and native program untouched', async () => {
  const deletion = { busy: () => false, remove: vi.fn(async () => true) };
  vi.mocked(confirmDialog).mockResolvedValue(false);
  nativeFileDeletionAction(track, deletion, () => true).onSelect(); await settle();
  expect(deletion.remove).not.toHaveBeenCalled(); expect(toast.success).not.toHaveBeenCalled();
});
it('a confirmed complete deletion uses the shared success feedback', async () => {
  const deletion = { busy: () => false, remove: vi.fn(async () => true) };
  vi.mocked(confirmDialog).mockResolvedValue(true);
  nativeFileDeletionAction(track, deletion, () => true).onSelect(); await settle();
  expect(deletion.remove).toHaveBeenCalledWith(track); expect(toast.success).toHaveBeenCalledWith('toast.trackDeleted');
});
it('partial cleanup failure reports failure instead of success', async () => {
  const deletion = { busy: () => false, remove: vi.fn(async () => { throw new Error('copy'); }) };
  vi.mocked(confirmDialog).mockResolvedValue(true);
  nativeFileDeletionAction(track, deletion, () => true).onSelect(); await settle();
  expect(toast.error).toHaveBeenCalledWith('toast.deleteFailed'); expect(toast.success).not.toHaveBeenCalled();
});
it('account change while confirming never calls the previous action', async () => {
  let active = true;
  const deletion = { busy: () => false, remove: vi.fn(async () => true) };
  vi.mocked(confirmDialog).mockImplementation(async () => { active = false; return true; });
  nativeFileDeletionAction(track, deletion, () => active).onSelect(); await settle();
  expect(deletion.remove).not.toHaveBeenCalled(); expect(toast.success).not.toHaveBeenCalled();
});
