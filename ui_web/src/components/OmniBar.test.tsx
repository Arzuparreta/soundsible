import { fireEvent, render, screen } from '@solidjs/testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { actions, setNowPlayingOpen, state } = vi.hoisted(() => ({
  actions: {
    togglePlay: vi.fn(),
    next: vi.fn(),
    autoSkip: vi.fn(),
    enterAutoMode: vi.fn(),
    setVolume: vi.fn(),
    toggleMute: vi.fn(),
    stopRadio: vi.fn(),
    dismissPlayback: vi.fn(),
  },
  setNowPlayingOpen: vi.fn(),
  state: {
    online: true,
    autoMode: { active: false },
    playback: {
      currentTrack: { id: 'track-1', title: 'A track', artist: 'An artist' },
      currentTime: 30,
      duration: 120,
      isPlaying: true,
      isLoading: false,
      loadError: '',
      volume: 0.8,
      muted: false,
      radioMode: true,
      radioLoading: false,
    },
  },
}));

vi.mock('../stores', () => ({ actions, setNowPlayingOpen, state }));
vi.mock('../lib/config', () => ({ apiOrigin: () => '' }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));

import { OmniBar } from './OmniBar';

describe('OmniBar interaction structure', () => {
  beforeEach(() => {
    state.playback.volume = 0.8;
    state.playback.muted = false;
    actions.setVolume.mockClear();
  });

  it('keeps the radio action separate from the expand-player button', () => {
    render(() => <OmniBar />);

    const expand = screen.getByRole('button', { name: /A track/ });
    const radio = screen.getByRole('button', { name: 'nowPlaying.radioActiveAria' });
    expect(expand).not.toContainElement(radio);

    fireEvent.click(expand);
    expect(setNowPlayingOpen).toHaveBeenCalledWith(true);
  });

  it('names the loading transport as Cancel', () => {
    state.playback.isLoading = true;
    render(() => <OmniBar />);

    expect(screen.getByRole('button', { name: 'common.cancel' })).toBeInTheDocument();
    state.playback.isLoading = false;
  });

  it('exposes the mode without reserving a horizontal control', () => {
    const normal = render(() => <OmniBar />);
    expect(screen.getByRole('button', { name: 'nowPlaying.modeLabel: A track — An artist' })).toBeInTheDocument();
    expect(screen.queryByText('DJ')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'nowPlaying.modeSelector' })).not.toBeInTheDocument();
    normal.unmount();

    state.autoMode.active = true;
    const dj = render(() => <OmniBar />);
    const expand = screen.getByRole('button', { name: 'autoMode.label: A track — An artist' });
    expect(expand).toBeInTheDocument();
    expect(screen.getByText('DJ')).toHaveAttribute('aria-hidden', 'true');
    expect(expand.parentElement).toContainElement(screen.getByText('DJ'));
    expect(expand).not.toContainElement(screen.getByRole('link', { name: 'An artist' }));
    dj.unmount();
    state.autoMode.active = false;
  });

  it('maps the volume slider and wheel through the perceptual audio taper', () => {
    state.playback.volume = 0.1;
    render(() => <OmniBar />);

    const slider = screen.getByRole('slider', { name: 'omnibar.volume' });
    expect(slider).toHaveValue('50');
    expect(slider).toHaveAttribute('aria-valuetext', '50%');

    fireEvent.input(slider, { target: { value: '50' } });
    expect(actions.setVolume).toHaveBeenLastCalledWith(expect.closeTo(0.1, 10));

    actions.setVolume.mockClear();
    fireEvent.wheel(slider, { deltaY: -1 });
    expect(actions.setVolume).toHaveBeenCalledWith(expect.closeTo(0.1276447, 6));
  });
});

function pointer(node: Element, type: string, x: number, y: number, extra = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, ...extra });
  fireEvent(node, event);
}

describe('mobile deck dismissal', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('dismisses a left swipe and consumes its trailing click', () => {
    const view = render(() => <OmniBar />);
    const bar = view.container.querySelector('[data-omni-player]')!;
    const button = screen.getByRole('button', { name: /A track/ });
    pointer(button, 'pointerdown', 280, 30);
    pointer(bar, 'pointermove', 170, 32);
    // Taking capture from a child bubbles its loss through the bar.
    pointer(button, 'lostpointercapture', 170, 32);
    pointer(bar, 'pointerup', 170, 32);
    fireEvent.click(button);
    expect(actions.dismissPlayback).toHaveBeenCalledOnce();
    expect(setNowPlayingOpen).not.toHaveBeenCalled();
  });

  it.each([[30, 0], [-30, 0], [-100, 120], [0, 100]])('ignores a non-dismiss gesture (%s, %s)', (dx, dy) => {
    const view = render(() => <OmniBar />);
    const bar = view.container.querySelector('[data-omni-player]')!;
    pointer(bar, 'pointerdown', 200, 30);
    pointer(bar, 'pointermove', 200 + dx, 30 + dy);
    pointer(bar, 'pointerup', 200 + dx, 30 + dy);
    expect(actions.dismissPlayback).not.toHaveBeenCalled();
  });

  it('ignores cancelled gestures and mouse drags', () => {
    const view = render(() => <OmniBar />);
    const bar = view.container.querySelector('[data-omni-player]')!;
    pointer(bar, 'pointerdown', 200, 30);
    pointer(bar, 'pointermove', 100, 30);
    pointer(bar, 'pointercancel', 100, 30);
    pointer(bar, 'pointerup', 100, 30);
    pointer(bar, 'pointerdown', 200, 30, { pointerType: 'mouse' });
    pointer(bar, 'pointermove', 100, 30);
    pointer(bar, 'pointerup', 100, 30);
    expect(actions.dismissPlayback).not.toHaveBeenCalled();
  });

  it('does not dismiss on a desktop even with touch input', () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    try {
      const view = render(() => <OmniBar />);
      const bar = view.container.querySelector('[data-omni-player]')!;
      pointer(bar, 'pointerdown', 200, 30);
      pointer(bar, 'pointermove', 100, 30);
      pointer(bar, 'pointerup', 100, 30);
      expect(actions.dismissPlayback).not.toHaveBeenCalled();
    } finally { window.matchMedia = original; }
  });
});
