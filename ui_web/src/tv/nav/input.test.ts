import { describe, expect, it } from 'vitest';
import { isTextInputElement, normalizeTvKey } from './input';

describe('TV input normalization', () => {
  it('maps arrow keys to directions and allows repeats for scrolling', () => {
    expect(normalizeTvKey({ key: 'ArrowUp' })).toBe('up');
    expect(normalizeTvKey({ key: 'ArrowDown', repeat: true })).toBe('down');
    expect(normalizeTvKey({ key: 'ArrowLeft' })).toBe('left');
    expect(normalizeTvKey({ key: 'ArrowRight' })).toBe('right');
  });

  it('suppresses key repeat on Select/OK so held OK activates once', () => {
    expect(normalizeTvKey({ key: 'Enter', repeat: false })).toBe('select');
    expect(normalizeTvKey({ key: 'Enter', repeat: true })).toBeNull();
    expect(normalizeTvKey({ key: 'Select', repeat: true })).toBeNull();
    expect(normalizeTvKey({ key: ' ', code: 'Space', repeat: true })).toBeNull();
  });

  it('normalizes webOS (461), Tizen (10009), Escape, GoBack, XF86Back, and non-input Backspace', () => {
    expect(normalizeTvKey({ key: 'Unidentified', keyCode: 461 })).toBe('back');
    expect(normalizeTvKey({ key: 'Return', keyCode: 10009 })).toBe('back');
    expect(normalizeTvKey({ key: 'Escape' })).toBe('back');
    expect(normalizeTvKey({ key: 'GoBack' })).toBe('back');
    expect(normalizeTvKey({ key: 'XF86Back' })).toBe('back');
    expect(normalizeTvKey({ key: 'Backspace' })).toBe('back');

    // Repeats on back are suppressed.
    expect(normalizeTvKey({ key: 'Escape', repeat: true })).toBeNull();
  });

  it('keeps Backspace and horizontal arrows inside text inputs while allowing Escape back and vertical exit', () => {
    const input = document.createElement('input');
    input.type = 'search';
    expect(isTextInputElement(input)).toBe(true);
    expect(normalizeTvKey({ key: 'Backspace' }, input)).toBeNull();
    expect(normalizeTvKey({ key: 'ArrowLeft' }, input)).toBeNull();
    expect(normalizeTvKey({ key: 'ArrowRight' }, input)).toBeNull();
    expect(normalizeTvKey({ key: 'ArrowDown' }, input)).toBe('down');
    expect(normalizeTvKey({ key: 'Escape' }, input)).toBe('back');
  });

  it('maps hardware media transport keys', () => {
    expect(normalizeTvKey({ key: 'MediaPlayPause' })).toBe('media_toggle');
    expect(normalizeTvKey({ key: 'MediaPlay' })).toBe('media_play');
    expect(normalizeTvKey({ key: 'MediaPause' })).toBe('media_pause');
    expect(normalizeTvKey({ key: 'MediaTrackNext' })).toBe('media_next');
    expect(normalizeTvKey({ key: 'MediaTrackPrevious' })).toBe('media_prev');
    expect(normalizeTvKey({ key: 'MediaStop' })).toBe('media_stop');
  });
});
