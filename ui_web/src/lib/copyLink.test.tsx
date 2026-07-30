import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';
import { OverlayOutlet } from './overlay';
import { openCopyLinkDialog } from './copyLink';

const LINK = 'https://example.test/open/#t=abc';

function withExecCommand(result: boolean): void {
  Object.defineProperty(document, 'execCommand', { value: vi.fn(() => result), configurable: true });
}

// The dead end this dialog exists to prevent: the share sheet and both copy
// paths refused, and the user is left with nothing to send.
describe('copy-link dialog', () => {
  // The overlay registry is module state: a dialog left open outlives its test.
  afterEach(async () => {
    while (document.querySelector('[role="dialog"]')) {
      fireEvent.keyDown(window, { key: 'Escape' });
      await Promise.resolve();
    }
    Reflect.deleteProperty(document, 'execCommand');
    vi.restoreAllMocks();
  });

  it('shows the link, selected, so it can be copied by hand', async () => {
    render(() => <OverlayOutlet />);
    openCopyLinkDialog({ title: 'Copy this link', message: 'Manually, please', value: LINK });

    const input = (await screen.findByRole('textbox')) as HTMLInputElement;
    expect(input.value).toBe(LINK);
    expect(screen.getByText('Manually, please')).toBeInTheDocument();
    await waitFor(() => expect(input).toHaveFocus());
    expect(input.selectionEnd).toBe(LINK.length);
  });

  it('retries the copy — a click here is a fresh user gesture — and closes on success', async () => {
    withExecCommand(true);
    render(() => <OverlayOutlet />);
    openCopyLinkDialog({ title: 'Copy this link', value: LINK });

    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  });

  it('stays open, with the link reselected, when the retry is refused too', async () => {
    withExecCommand(false);
    render(() => <OverlayOutlet />);
    openCopyLinkDialog({ title: 'Copy this link', value: LINK });

    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));

    await waitFor(() => {
      const input = screen.getByRole('textbox') as HTMLInputElement;
      expect(input.selectionEnd).toBe(LINK.length);
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
