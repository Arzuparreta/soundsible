import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';
import { OverlayOutlet, openOverlay } from './overlay';
import { setMediaQuery } from '../test-setup';

// The reason this whole rewrite exists: overlays must leave zero orphaned DOM
// when closed. The legacy player document.body.appendChild'd modals and forgot
// them. Here every overlay lives in one reactive registry behind a single
// <Portal>, so closing disposes the DOM. These tests lock that in.
describe('overlay manager (anti-leak)', () => {
  it('mounts overlay content, then removes every node on close', async () => {
    render(() => <OverlayOutlet />);
    expect(screen.queryByText('Leak check')).toBeNull();

    const close = openOverlay(() => <p>Leak check</p>);
    expect(await screen.findByText('Leak check')).toBeInTheDocument();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    close();
    await waitFor(() => expect(screen.queryByText('Leak check')).toBeNull());
    // No orphaned dialog/scrim left in the document.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('dismisses the top dismissable overlay on Escape', async () => {
    render(() => <OverlayOutlet />);
    openOverlay(() => <p>Esc me</p>);
    expect(await screen.findByText('Esc me')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Esc me')).toBeNull());
  });

  it('keeps a non-dismissable overlay open on Escape', async () => {
    render(() => <OverlayOutlet />);
    const close = openOverlay(() => <p>Sticky</p>, { dismissable: false });
    expect(await screen.findByText('Sticky')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText('Sticky')).toBeInTheDocument();

    close(); // don't leak into the next test
    await waitFor(() => expect(screen.queryByText('Sticky')).toBeNull());
  });

  it('stacks a dialog opened from inside a window above it, and only closes that one', async () => {
    // The reason the settings window is an entry in this registry rather than a
    // portal of its own: settings content opens confirm/prompt/password
    // dialogs, and a second portal at the same z-index would stack by DOM order
    // instead of by open order. Here the last one opened is the one Escape gets.
    render(() => <OverlayOutlet />);
    openOverlay(() => <p>Window body</p>, { variant: 'window', ariaLabel: 'Window' });
    expect(await screen.findByText('Window body')).toBeInTheDocument();

    openOverlay(() => <p>Nested confirm</p>, { ariaLabel: 'Confirm' });
    expect(await screen.findByText('Nested confirm')).toBeInTheDocument();

    const dialogs = document.querySelectorAll('[role="dialog"]');
    expect([...dialogs].map((dialog) => dialog.getAttribute('aria-label'))).toEqual([
      'Window',
      'Confirm',
    ]);

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByText('Nested confirm')).toBeNull());
    expect(screen.queryByText('Window body')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Window body')).toBeNull());
  });

  it('marks the surface so a window can be sized differently from a sheet', async () => {
    render(() => <OverlayOutlet />);
    const close = openOverlay(() => <p>Windowed</p>, { variant: 'window' });

    expect(await screen.findByText('Windowed')).toBeInTheDocument();
    expect(document.querySelector('[role="dialog"]')).toHaveAttribute('data-variant', 'window');

    close();
    await waitFor(() => expect(screen.queryByText('Windowed')).toBeNull());
  });

  it('defaults to the sheet surface', async () => {
    render(() => <OverlayOutlet />);
    const close = openOverlay(() => <p>Sheeted</p>);

    expect(await screen.findByText('Sheeted')).toBeInTheDocument();
    expect(document.querySelector('[role="dialog"]')).toHaveAttribute('data-variant', 'sheet');

    close();
    await waitFor(() => expect(screen.queryByText('Sheeted')).toBeNull());
  });

  it('returns focus to the control that opened a dismissed overlay', async () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    render(() => <OverlayOutlet />);
    openOverlay(() => <button type="button">Inside</button>, { ariaLabel: 'Focus check' });

    expect(await screen.findByRole('dialog', { name: 'Focus check' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Inside' })).toHaveFocus());

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveFocus());
    trigger.remove();
  });
});

/** jsdom has no touch input, so the gesture is fed the shape it reads: an
    identified touch on `touches`, and the same one on `changedTouches`. */
function touch(type: 'touchstart' | 'touchmove' | 'touchend', x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const point = { clientX: x, clientY: y, identifier: 1 };
  const list = { length: 1, item: () => point };
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' ? { length: 0, item: () => null } : list,
  });
  Object.defineProperty(event, 'changedTouches', { value: list });
  return event;
}

function drag(target: Element, dx: number, dy: number) {
  target.dispatchEvent(touch('touchstart', 200, 200));
  target.dispatchEvent(touch('touchmove', 200 + dx / 4, 200 + dy / 4));
  target.dispatchEvent(touch('touchmove', 200 + dx, 200 + dy));
  target.dispatchEvent(touch('touchend', 200 + dx, 200 + dy));
}

const sheet = () => document.querySelector('[role="dialog"]')!;
const MOBILE = '(max-width: 1023px)';

/* The sheet has always drawn a grabber. These lock in that it now means
   something — and, just as importantly, that it means nothing where the surface
   is not against an edge or is not dismissable at all. */
describe('drag to dismiss', () => {
  afterEach(() => setMediaQuery(MOBILE, false));

  it('closes a bottom sheet dragged downwards', async () => {
    setMediaQuery(MOBILE, true);
    render(() => <OverlayOutlet />);
    openOverlay(() => <p>Swipe me</p>);
    expect(await screen.findByText('Swipe me')).toBeInTheDocument();

    drag(sheet(), 0, 160);
    await waitFor(() => expect(screen.queryByText('Swipe me')).toBeNull());
  });

  it('closes a left drawer dragged towards the edge it came from', async () => {
    setMediaQuery(MOBILE, true);
    render(() => <OverlayOutlet />);
    openOverlay(() => <p>Drawer</p>, { variant: 'drawer' });
    expect(await screen.findByText('Drawer')).toBeInTheDocument();

    drag(sheet(), -160, 0);
    await waitFor(() => expect(screen.queryByText('Drawer')).toBeNull());
  });

  it('keeps a drawer dragged further open, and a sheet dragged upwards', async () => {
    setMediaQuery(MOBILE, true);
    render(() => <OverlayOutlet />);
    const closeDrawer = openOverlay(() => <p>Drawer</p>, { variant: 'drawer' });
    expect(await screen.findByText('Drawer')).toBeInTheDocument();
    drag(sheet(), 160, 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Drawer')).toBeInTheDocument();
    closeDrawer();

    openOverlay(() => <p>Upwards</p>);
    expect(await screen.findByText('Upwards')).toBeInTheDocument();
    drag(sheet(), 0, -160);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Upwards')).toBeInTheDocument();
  });

  it('leaves a full-screen window and a non-dismissable sheet alone', async () => {
    setMediaQuery(MOBILE, true);
    render(() => <OverlayOutlet />);
    const closeWindow = openOverlay(() => <p>Settings</p>, { variant: 'window' });
    expect(await screen.findByText('Settings')).toBeInTheDocument();
    drag(sheet(), 0, 160);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Settings')).toBeInTheDocument();
    closeWindow();

    openOverlay(() => <p>Sticky</p>, { dismissable: false });
    expect(await screen.findByText('Sticky')).toBeInTheDocument();
    drag(sheet(), 0, 160);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Sticky')).toBeInTheDocument();
  });

  it('does not arm where the sheet is a centred card', async () => {
    setMediaQuery(MOBILE, false);
    render(() => <OverlayOutlet />);
    openOverlay(() => <p>Desktop card</p>);
    expect(await screen.findByText('Desktop card')).toBeInTheDocument();

    drag(sheet(), 0, 160);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Desktop card')).toBeInTheDocument();
  });
});


describe('history-backed overlay feedback', () => {
  it('dismisses immediately but waits for popstate before navigating', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    const navigate = vi.fn();
    render(() => <OverlayOutlet />);
    openOverlay(close => <button onClick={() => close(navigate)}>Choose artists</button>, { history: true, ariaLabel: 'Pending navigation' });
    fireEvent.click(screen.getByText('Choose artists'));
    expect(screen.queryByRole('dialog', { name: 'Pending navigation' })).toBeNull();
    expect(back).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(navigate).toHaveBeenCalledOnce();
    back.mockRestore();
    window.history.replaceState(null, '');
  });
});
