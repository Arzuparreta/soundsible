import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';
import { OverlayOutlet, openOverlay } from './overlay';

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
