import { fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMediaQuery } from '../test-setup';

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
    seek: vi.fn(),
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
vi.mock('../lib/config', () => ({ apiOrigin: () => '', mediaOrigin: () => '', artworkUrl: (url?: string | null) => url || undefined }));
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

/** The breakpoint listLayout watches, and the one OmniBar's CSS switches on. */
const MOBILE = '(max-width: 1023px)';

describe('mobile deck dismissal', () => {
  beforeEach(() => { vi.clearAllMocks(); setMediaQuery(MOBILE, true); });
  afterEach(() => setMediaQuery(MOBILE, false));

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
    setMediaQuery(MOBILE, false);
    const view = render(() => <OmniBar />);
    const bar = view.container.querySelector('[data-omni-player]')!;
    pointer(bar, 'pointerdown', 200, 30);
    pointer(bar, 'pointermove', 100, 30);
    pointer(bar, 'pointerup', 100, 30);
    expect(actions.dismissPlayback).not.toHaveBeenCalled();
  });
});

/* The pill is one press to open the player. Anything inside it that is not a
   transport control has to lead there too — a link that took the tap to an
   artist page, or artwork that swallowed it and did nothing, both broke the
   only promise the bar makes on a phone. */
describe('what the compact pill does with a tap', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => setMediaQuery(MOBILE, false));

  it('says the artist without offering a second destination on a phone', () => {
    setMediaQuery(MOBILE, true);
    render(() => <OmniBar />);

    expect(screen.queryByRole('link', { name: 'An artist' })).toBeNull();
    // Still said, and still inside the area the open button covers.
    const said = screen.getByText('An artist');
    expect(screen.getByRole('button', { name: /A track/ }).parentElement).toContainElement(said);
  });

  it('keeps the artist a link on a desktop, where the bar has room for both', () => {
    setMediaQuery(MOBILE, false);
    render(() => <OmniBar />);

    expect(screen.getByRole('link', { name: 'An artist' })).toBeInTheDocument();
  });

  it('leaves the artwork to the open button instead of taking the tap itself', () => {
    setMediaQuery(MOBILE, true);
    const view = render(() => <OmniBar />);

    // The cover is decoration with no handler of its own; what must not happen
    // is it sitting above the open button and eating the press, which is what
    // being positioned and later in the DOM made it do.
    const cover = view.container.querySelector<HTMLElement>('[data-omni-cover]')!;
    expect(cover).not.toHaveAttribute('role', 'button');
    expect(cover.querySelector('button, a')).toBeNull();
  });
});


describe('seek and pill gesture arbitration', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); setMediaQuery(MOBILE, true); });
  afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); setMediaQuery(MOBILE, false); });

  it('a claimed seek cannot dismiss or open the pill and leaves transport usable', () => {
    const { container } = render(() => <OmniBar />);
    const slider = screen.getByRole('slider', { name: 'nowPlaying.seekLabel' });
    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 400 } as DOMRect);
    pointer(slider, 'pointerdown', 300, 20);
    vi.advanceTimersByTime(400);
    pointer(slider, 'pointermove', 140, 20);
    pointer(slider, 'pointerup', 140, 20);
    fireEvent.click(slider);
    expect(actions.seek).toHaveBeenCalledExactlyOnceWith(0);
    expect(actions.dismissPlayback).not.toHaveBeenCalled();
    expect(setNowPlayingOpen).not.toHaveBeenCalled();
    expect(container.querySelector('[data-omni-player]')).not.toHaveStyle({ transform: 'translateX(-160px)' });
    fireEvent.click(screen.getByRole('button', { name: 'common.pause' }));
    expect(actions.togglePlay).toHaveBeenCalledOnce();
  });

  it('a swipe begun on the rail before the hold still dismisses the pill', () => {
    const { container } = render(() => <OmniBar />);
    const slider = screen.getByRole('slider', { name: 'nowPlaying.seekLabel' });
    const bar = container.querySelector('[data-omni-player]')!;
    pointer(slider, 'pointerdown', 300, 20);
    pointer(slider, 'pointermove', 140, 20);
    pointer(bar, 'pointerup', 140, 20);
    vi.advanceTimersByTime(400);
    expect(actions.dismissPlayback).toHaveBeenCalledOnce();
    expect(actions.seek).not.toHaveBeenCalled();
  });
});


describe('whole-pill hold', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); setMediaQuery(MOBILE, true); });
  afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); setMediaQuery(MOBILE, false); });

  it.each(['open', 'pause', 'next', 'edge'])('captures a hold starting on %s without triggering its tap or dismissal', target => {
    const { container } = render(() => <OmniBar />);
    const bar = container.querySelector('[data-omni-player]')!;
    const slider = screen.getByRole('slider', { name: 'nowPlaying.seekLabel' });
    vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 400 } as DOMRect);
    const origin = target === 'edge' ? bar : screen.getByRole('button', { name: target === 'open' ? /A track/ : target === 'pause' ? 'common.pause' : 'common.next' });
    pointer(origin, 'pointerdown', 280, 35);
    vi.advanceTimersByTime(250);
    expect(bar).not.toHaveAttribute('data-seek-active');
    vi.advanceTimersByTime(150);
    expect(bar).toHaveAttribute('data-seek-active');
    if (origin !== bar) pointer(origin, 'lostpointercapture', 280, 35);
    expect(bar).toHaveAttribute('data-seek-active');
    pointer(bar, 'pointermove', 200, 35);
    pointer(bar, 'pointerup', 200, 35);
    fireEvent.click(origin, { detail: 1 });
    expect(actions.seek).toHaveBeenCalledExactlyOnceWith(6);
    expect(actions.dismissPlayback).not.toHaveBeenCalled();
    expect(actions.togglePlay).not.toHaveBeenCalled();
    expect(actions.next).not.toHaveBeenCalled();
    expect(setNowPlayingOpen).not.toHaveBeenCalled();
  });

  it('cancelling a claimed hold never falls through to the original button', () => {
    const { container } = render(() => <OmniBar />);
    const bar = container.querySelector('[data-omni-player]')!;
    const pause = screen.getByRole('button', { name: 'common.pause' });
    pointer(pause, 'pointerdown', 280, 35);
    vi.advanceTimersByTime(400);
    pointer(bar, 'lostpointercapture', 280, 35);
    pointer(pause, 'pointerup', 280, 35);
    fireEvent.click(pause, { detail: 1 });
    expect(actions.togglePlay).not.toHaveBeenCalled();
    expect(actions.seek).not.toHaveBeenCalled();
    pointer(pause, 'pointerdown', 280, 35);
    pointer(pause, 'pointerup', 280, 35);
    fireEvent.click(pause, { detail: 1 });
    expect(actions.togglePlay).toHaveBeenCalledOnce();
  });

});
