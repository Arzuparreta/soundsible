import { render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OverlayOutlet } from './overlay';
import { setMediaQuery } from '../test-setup';
import { dismissSettings, openSettings, settingsOpen } from './settingsSurface';

/**
 * On a phone, back is a swipe, and a window that owns no history entry lets
 * that gesture unwind the page behind it while staying on top — which reads as
 * a stuck screen. These tests pin the entries the window pushes and what a
 * traversal does to them.
 */
const DESKTOP = '(min-width: 1024px)';
const MARK = '__soundsibleSettings';

const mark = () => (window.history.state ?? {})[MARK] ?? null;

/** A same-document traversal is asynchronous: wait for the entry to change. */
async function traverse(move: () => void) {
  const before = JSON.stringify(mark());
  move();
  await waitFor(() => expect(JSON.stringify(mark())).not.toBe(before));
}

const goBack = () => traverse(() => window.history.back());
const goForward = () => traverse(() => window.history.forward());

beforeEach(() => {
  setMediaQuery(DESKTOP, false);
  window.history.replaceState({}, '', '/');
  render(() => <OverlayOutlet />);
});

afterEach(() => {
  dismissSettings();
  setMediaQuery(DESKTOP, false);
});

describe('settings window history', () => {
  it('gives the back gesture an entry to pop instead of unwinding the app', async () => {
    openSettings();

    expect(settingsOpen()).toBe(true);
    expect(mark()).toEqual({ depth: 1, section: null });

    await goBack();

    await waitFor(() => expect(settingsOpen()).toBe(false));
    expect(mark()).toBeNull();
  });

  it('on mobile, back leaves a submenu for the index rather than the app', async () => {
    openSettings();
    openSettings('playback');

    expect(mark()).toEqual({ depth: 2, section: 'playback' });

    await goBack();

    // Still open — one level up, not gone.
    expect(settingsOpen()).toBe(true);
    expect(mark()).toEqual({ depth: 1, section: null });

    await goBack();

    await waitFor(() => expect(settingsOpen()).toBe(false));
  });

  it('puts the index under a deep link so back has somewhere to land', async () => {
    // What a paired device sends its owner back to.
    openSettings('devices');

    expect(mark()).toEqual({ depth: 2, section: 'devices' });

    await goBack();

    expect(settingsOpen()).toBe(true);
    expect(mark()).toEqual({ depth: 1, section: null });
  });

  it('on desktop a submenu is not a push, so back leaves settings outright', async () => {
    setMediaQuery(DESKTOP, true);
    openSettings();
    openSettings('playback');

    // The index never left the screen, so switching section replaced the entry.
    expect(mark()).toEqual({ depth: 1, section: 'playback' });

    await goBack();

    await waitFor(() => expect(settingsOpen()).toBe(false));
  });

  it('reopens on the entry it was left on when history moves forward again', async () => {
    openSettings();
    openSettings('playback');
    await goBack();
    expect(settingsOpen()).toBe(true);

    await goForward();

    expect(settingsOpen()).toBe(true);
    expect(mark()).toEqual({ depth: 2, section: 'playback' });
  });

  it('does not stack a second window when asked to open again', async () => {
    openSettings();
    openSettings('playback');

    expect(await screen.findAllByRole('dialog')).toHaveLength(1);
  });
});
