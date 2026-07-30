import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  openContextMenu: vi.fn(),
}));

vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
vi.mock('../lib/contextMenu', () => ({ openContextMenu: harness.openContextMenu }));

import { NowPlayingLayoutControl } from './NowPlayingLayoutControl';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('NowPlayingLayoutControl', () => {
  it('opens an explicit layout menu without presenting itself as a toggle', () => {
    const onSelect = vi.fn();
    const onReset = vi.fn();
    render(() => <NowPlayingLayoutControl onSelect={onSelect} onReset={onReset} />);

    const control = screen.getByRole('button', { name: 'nowPlaying.changeLayout' });
    expect(control).toHaveAttribute('aria-haspopup', 'menu');
    expect(control).not.toHaveAttribute('aria-pressed');
    fireEvent.click(control);

    expect(harness.openContextMenu).toHaveBeenCalledOnce();
    const options = harness.openContextMenu.mock.calls[0][0];
    expect(options.title).toBe('nowPlaying.layoutWorkspace');
    expect(options.actions.map((action: { label: string }) => action.label)).toEqual([
      'nowPlaying.layoutBalanced',
      'nowPlaying.layoutPlayer',
      'nowPlaying.layoutExplore',
      'nowPlaying.layoutQueue',
      'nowPlaying.resetLayout',
    ]);

    options.actions[2].onSelect();
    options.actions[4].onSelect();
    expect(onSelect).toHaveBeenCalledWith('explore');
    expect(onReset).toHaveBeenCalledOnce();
  });
});
