import { describe, expect, it } from 'vitest';
import {
  initialMobileVisualState,
  toggleMobileLyrics,
  toggleMobileQueue,
} from './nowPlayingMobileVisual';

describe('mobile Now Playing visual state', () => {
  it('restores open lyrics after the queue is opened and closed', () => {
    const lyricsOpen = toggleMobileLyrics(initialMobileVisualState);
    const queueOpen = toggleMobileQueue(lyricsOpen);
    const queueClosed = toggleMobileQueue(queueOpen);

    expect(queueOpen).toEqual({ content: 'lyrics', queueOpen: true });
    expect(queueClosed).toEqual({ content: 'lyrics', queueOpen: false });
  });

  it('restores the cover when the queue was opened from the cover', () => {
    const queueOpen = toggleMobileQueue(initialMobileVisualState);

    expect(toggleMobileQueue(queueOpen)).toEqual(initialMobileVisualState);
  });
});
