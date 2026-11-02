import { describe, expect, it } from 'vitest';
import {
  initialMobileVisualState,
  toggleMobileLyrics,
} from './nowPlayingMobileVisual';

describe('mobile Now Playing visual state', () => {
  it('toggles between cover and lyrics', () => {
    const lyricsOpen = toggleMobileLyrics(initialMobileVisualState);
    expect(lyricsOpen).toEqual({ content: 'lyrics' });
    expect(toggleMobileLyrics(lyricsOpen)).toEqual(initialMobileVisualState);
  });
});
