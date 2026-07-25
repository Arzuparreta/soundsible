import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createShortcutHandler, SEEK_STEP_SEC, VOLUME_STEP, type ShortcutContext } from './shortcuts';

function makeActions() {
  return {
    togglePlay: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    seekBy: vi.fn(),
    nudgeVolume: vi.fn(),
    toggleMute: vi.fn(),
    toggleShuffle: vi.fn(),
    cycleRepeat: vi.fn(),
    toggleFavourite: vi.fn(),
    enterAutoMode: vi.fn(),
    exitAutoMode: vi.fn(),
    closeNowPlaying: vi.fn(),
  };
}

const idle: ShortcutContext = {
  autoModeActive: false,
  nowPlayingOpen: false,
  autoModeAvailable: true,
};

let actions: ReturnType<typeof makeActions>;
let context: ShortcutContext;
let handle: (event: KeyboardEvent) => void;

/** Dispatch a key against `target` (default: a plain, non-interactive div). */
function press(init: KeyboardEventInit & { target?: HTMLElement } = {}): KeyboardEvent {
  const { target, ...eventInit } = init;
  const el = target ?? document.createElement('div');
  document.body.appendChild(el);
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...eventInit });
  el.dispatchEvent(event);
  el.remove();
  return event;
}

beforeEach(() => {
  actions = makeActions();
  context = { ...idle };
  handle = createShortcutHandler(() => context, actions);
  document.addEventListener('keydown', handle);
  return () => document.removeEventListener('keydown', handle);
});

describe('transport keys', () => {
  it('toggles playback on Space and swallows the page scroll', () => {
    const event = press({ code: 'Space' });
    expect(actions.togglePlay).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('seeks with bare arrows and changes track with Shift+arrows', () => {
    press({ code: 'ArrowRight' });
    press({ code: 'ArrowLeft' });
    expect(actions.seekBy).toHaveBeenNthCalledWith(1, SEEK_STEP_SEC);
    expect(actions.seekBy).toHaveBeenNthCalledWith(2, -SEEK_STEP_SEC);

    press({ code: 'ArrowRight', shiftKey: true });
    press({ code: 'ArrowLeft', shiftKey: true });
    expect(actions.next).toHaveBeenCalledTimes(1);
    expect(actions.prev).toHaveBeenCalledTimes(1);
    // Shift+arrow is a track change, never also a seek.
    expect(actions.seekBy).toHaveBeenCalledTimes(2);
  });

  it('binds volume to Shift+Up/Down and leaves bare Up/Down to the page', () => {
    press({ code: 'ArrowUp', shiftKey: true });
    press({ code: 'ArrowDown', shiftKey: true });
    expect(actions.nudgeVolume).toHaveBeenNthCalledWith(1, VOLUME_STEP);
    expect(actions.nudgeVolume).toHaveBeenNthCalledWith(2, -VOLUME_STEP);

    // Scrolling a long list with the arrow keys has to keep working.
    const scroll = press({ code: 'ArrowUp' });
    expect(actions.nudgeVolume).toHaveBeenCalledTimes(2);
    expect(scroll.defaultPrevented).toBe(false);
  });

  it('maps the letter shortcuts', () => {
    press({ key: 'k' });
    press({ key: 'm' });
    press({ key: 'f' });
    press({ key: 's' });
    press({ key: 'r' });
    expect(actions.togglePlay).toHaveBeenCalledTimes(1);
    expect(actions.toggleMute).toHaveBeenCalledTimes(1);
    expect(actions.toggleFavourite).toHaveBeenCalledTimes(1);
    expect(actions.toggleShuffle).toHaveBeenCalledTimes(1);
    expect(actions.cycleRepeat).toHaveBeenCalledTimes(1);
  });

  it('is case insensitive but ignores shifted letters', () => {
    press({ key: 'M' });
    expect(actions.toggleMute).toHaveBeenCalledTimes(1);

    press({ key: 'M', shiftKey: true });
    expect(actions.toggleMute).toHaveBeenCalledTimes(1);
  });
});

describe('keys that are not ours', () => {
  it.each([
    ['ctrlKey', { ctrlKey: true }],
    ['metaKey', { metaKey: true }],
    ['altKey', { altKey: true }],
  ])('ignores everything held with %s', (_name, modifier) => {
    // Ctrl+→ switches desktops, Cmd+A selects all, Alt+← goes back. Claiming
    // these made the player fight the OS and the browser.
    press({ code: 'Space', ...modifier });
    press({ code: 'ArrowRight', ...modifier });
    press({ key: 'a', ...modifier });
    press({ key: 'm', ...modifier });

    expect(actions.togglePlay).not.toHaveBeenCalled();
    expect(actions.seekBy).not.toHaveBeenCalled();
    expect(actions.toggleMute).not.toHaveBeenCalled();
  });

  it.each(['input', 'textarea'])('stays out of the way while typing in a <%s>', (tag) => {
    const field = document.createElement(tag);
    press({ code: 'Space', target: field });
    press({ key: 'm', target: field });
    expect(actions.togglePlay).not.toHaveBeenCalled();
    expect(actions.toggleMute).not.toHaveBeenCalled();
  });

  it('stays out of the way inside a contenteditable', () => {
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    // jsdom does not derive isContentEditable from the attribute.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    press({ code: 'Space', target: editable });
    expect(actions.togglePlay).not.toHaveBeenCalled();
  });

  it('lets a focused control keep Space', () => {
    // Tabbing to Shuffle and pressing Space must toggle shuffle — which the
    // button does natively — not hijack Space for playback.
    press({ code: 'Space', target: document.createElement('button') });
    expect(actions.togglePlay).not.toHaveBeenCalled();

    const row = document.createElement('div');
    row.setAttribute('role', 'button');
    press({ code: 'Space', target: row });
    expect(actions.togglePlay).not.toHaveBeenCalled();
  });

  it('ignores an event something closer already handled', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    el.addEventListener('keydown', (e) => e.preventDefault());
    el.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true }));
    el.remove();
    expect(actions.togglePlay).not.toHaveBeenCalled();
  });
});

describe('Escape and Auto Mode', () => {
  it('leaves Auto Mode before it closes the sheet reporting on it', () => {
    context = { ...idle, autoModeActive: true, nowPlayingOpen: true };
    press({ key: 'Escape' });
    expect(actions.exitAutoMode).toHaveBeenCalledTimes(1);
    expect(actions.closeNowPlaying).not.toHaveBeenCalled();

    context = { ...idle, nowPlayingOpen: true };
    press({ key: 'Escape' });
    expect(actions.closeNowPlaying).toHaveBeenCalledTimes(1);
  });

  it('toggles Auto Mode with "a" only from an open Now Playing sheet', () => {
    press({ key: 'a' });
    expect(actions.enterAutoMode).not.toHaveBeenCalled();

    context = { ...idle, nowPlayingOpen: true };
    press({ key: 'a' });
    expect(actions.enterAutoMode).toHaveBeenCalledTimes(1);

    context = { ...context, autoModeActive: true };
    press({ key: 'a' });
    expect(actions.exitAutoMode).toHaveBeenCalledTimes(1);
  });

  it('does not offer Auto Mode for a podcast', () => {
    context = { ...idle, nowPlayingOpen: true, autoModeAvailable: false };
    press({ key: 'a' });
    expect(actions.enterAutoMode).not.toHaveBeenCalled();
  });
});
