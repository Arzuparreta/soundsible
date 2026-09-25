import { fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setMediaQuery } from '../test-setup';
import { InShell } from './AppBar.harness';
import { ViewHeader } from './ViewHeader';

const DESKTOP = '(min-width: 1024px)';

afterEach(() => setMediaQuery(DESKTOP, false));

describe('ViewHeader on the desktop shell', () => {
  it('renders the title as plain text when no tap handler is given', () => {
    setMediaQuery(DESKTOP, true);
    render(() => <InShell><ViewHeader title="Your library" /></InShell>);

    expect(screen.queryByRole('button', { name: 'Your library' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Your library' })).toBeInTheDocument();
    expect(document.querySelector('[data-app-bar]')).toBeNull();
  });

  it('tapping the title invokes onTitleTap', () => {
    setMediaQuery(DESKTOP, true);
    const onTitleTap = vi.fn();
    render(() => <InShell><ViewHeader title="Your library" onTitleTap={onTitleTap} /></InShell>);

    fireEvent.click(screen.getByRole('button', { name: 'Your library' }));

    expect(onTitleTap).toHaveBeenCalledOnce();
  });
});

describe('ViewHeader on the touch shell', () => {
  it('hands its title and commands to the top bar instead of drawing a header', () => {
    const onSelect = vi.fn();
    render(() => (
      <InShell>
        <ViewHeader
          title="Your library"
          meta="12 songs"
          actions={<button type="button">Desktop only</button>}
          barActions={[{ label: 'Sort', icon: () => null, onSelect }]}
        />
      </InShell>
    ));

    const bar = document.querySelector<HTMLElement>('[data-app-bar]')!;
    expect(bar).toContainElement(screen.getByRole('heading', { name: 'Your library', level: 1 }));
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    expect(screen.queryByText('12 songs')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Desktop only' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('keeps compact panel headers in place, out of the top bar', () => {
    render(() => (
      <InShell>
        <ViewHeader title="Page" />
        <ViewHeader title="Panel" compact />
      </InShell>
    ));

    const bar = document.querySelector<HTMLElement>('[data-app-bar]')!;
    expect(bar).toHaveTextContent('Page');
    expect(bar).not.toHaveTextContent('Panel');
    expect(screen.getByRole('heading', { name: 'Panel' })).toBeInTheDocument();
  });
});

// Navigation behavior is covered by the router integration and browser tests.
vi.mock('./NavigationMenu', () => ({ NavigationMenuButton: () => null }));
