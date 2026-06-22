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
});
