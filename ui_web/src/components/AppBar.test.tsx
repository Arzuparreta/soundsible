import { fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal, Show } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { useAppBar, type AppBarConfig } from '../lib/appBar';
import { InShell } from './AppBar.harness';

function Page(props: AppBarConfig) {
  useAppBar(props);
  return null;
}

const bar = () => document.querySelector<HTMLElement>('[data-app-bar]')!;

describe('AppBar', () => {
  it('draws the title the page on screen declares', () => {
    render(() => <InShell><Page title={() => 'Songs'} /></InShell>);

    expect(screen.getByRole('heading', { name: 'Songs', level: 1 })).toBeInTheDocument();
    expect(bar()).toContainElement(screen.getByRole('heading', { name: 'Songs' }));
  });

  it('follows the newest page and falls back when it leaves', () => {
    const [detail, setDetail] = createSignal(true);
    render(() => (
      <InShell>
        <Page title={() => 'Playlists'} />
        <Show when={detail()}><Page title={() => 'Road trip'} back={() => {}} backLabel={() => 'Back to playlists'} /></Show>
      </InShell>
    ));

    expect(bar()).toHaveTextContent('Road trip');
    expect(screen.getByRole('button', { name: 'Back to playlists' })).toBeInTheDocument();

    setDetail(false);

    expect(bar()).toHaveTextContent('Playlists');
    expect(screen.queryByRole('button', { name: 'Back to playlists' })).toBeNull();
  });

  it('returns with the page’s own back action', () => {
    const back = vi.fn();
    render(() => <InShell><Page title={() => 'Album'} back={back} backLabel={() => 'Back to artist'} /></InShell>);

    fireEvent.click(screen.getByRole('button', { name: 'Back to artist' }));

    expect(back).toHaveBeenCalledOnce();
  });

  it('draws commands as labelled icon buttons, a prominent one as a worded pill', () => {
    const search = vi.fn();
    render(() => (
      <InShell>
        <Page
          title={() => 'Live'}
          actions={() => [
            { label: 'Search', icon: () => <svg />, onSelect: search, badge: 3 },
            { label: 'Go live', icon: () => null, prominent: true, disabled: true, onSelect: () => {} },
          ]}
        />
      </InShell>
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(search).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Search' })).toHaveTextContent('3');
    expect(screen.getByRole('button', { name: 'Go live' })).toBeDisabled();
  });

  it('lets the page decide what tapping the title does', () => {
    const onTitleTap = vi.fn();
    render(() => <InShell><Page title={() => 'Search'} onTitleTap={onTitleTap} /></InShell>);

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(onTitleTap).toHaveBeenCalledOnce();
  });

  it('echoes a page’s own large title for the eye only', () => {
    const heading = document.createElement('h1');
    render(() => <InShell><Page title={() => 'Blue'} heading={() => heading} /></InShell>);

    expect(screen.queryByRole('heading', { name: 'Blue' })).toBeNull();
    expect(bar().querySelector('[data-echo]')).toHaveAttribute('aria-hidden', 'true');
  });
});

vi.mock('./NavigationMenu', () => ({ NavigationMenuButton: () => null }));
