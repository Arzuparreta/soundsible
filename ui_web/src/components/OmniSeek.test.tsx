import { fireEvent, render, screen } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'solid-js/store';

const spies = vi.hoisted(() => ({ seek: vi.fn(), open: vi.fn() }));
const [state, setState] = createStore({ playback: {
  currentTrack: { id: 'one' }, currentTime: 30, duration: 120, isLoading: false, loadError: '',
} });
vi.mock('../stores', () => ({ get state() { return state; }, actions: { seek: spies.seek }, setNowPlayingOpen: spies.open }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
import { OmniSeek } from './OmniSeek';

function pointer(node: Element, type: string, x = 50, extra = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: 20, button: 0, ...extra });
  fireEvent(node, event);
}
function setup() {
  const claim = vi.fn();
  const view = render(() => <OmniSeek onClaim={claim} />);
  const slider = screen.getByRole('slider');
  vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 200 } as DOMRect);
  return { ...view, slider, claim };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  setState('playback', { currentTrack: { id: 'one' }, currentTime: 30, duration: 120, isLoading: false, loadError: '' });
});
afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); });

describe('deliberate mini-player seeking', () => {
  it('opens on a short inside tap without seeking, but ignores an outside tap', () => {
    const { slider, claim } = setup();
    pointer(slider, 'pointerdown'); vi.advanceTimersByTime(100); pointer(slider, 'pointerup');
    expect(spies.open).toHaveBeenCalledOnce(); expect(claim).not.toHaveBeenCalled();
    pointer(slider, 'pointerdown', 50, { clientY: 5 }); pointer(slider, 'pointerup', 50, { clientY: 5 });
    expect(spies.open).toHaveBeenCalledOnce(); expect(spies.seek).not.toHaveBeenCalled();
  });
  it('previews locally after the hold and commits once at release', () => {
    const { slider, claim } = setup();
    pointer(slider, 'pointerdown'); vi.advanceTimersByTime(400);
    expect(claim).toHaveBeenCalledOnce();
    pointer(slider, 'pointermove', 150);
    expect(slider).toHaveValue('90'); expect(spies.seek).not.toHaveBeenCalled();
    setState('playback', 'currentTime', 32);
    expect(slider).toHaveValue('90');
    pointer(slider, 'pointerup', 150);
    expect(spies.seek).toHaveBeenCalledExactlyOnceWith(90);
    expect(spies.open).not.toHaveBeenCalled();
  });
  it('does not seek or open when a hold ends without dragging', () => {
    const { slider } = setup();
    pointer(slider, 'pointerdown', 150); vi.advanceTimersByTime(400); pointer(slider, 'pointerup', 150);
    expect(spies.seek).not.toHaveBeenCalled(); expect(spies.open).not.toHaveBeenCalled();
  });
  it('leaves early swipes unclaimed', () => {
    const { slider, claim } = setup();
    pointer(slider, 'pointerdown'); pointer(slider, 'pointermove', 20);
    vi.advanceTimersByTime(300); pointer(slider, 'pointerup', 20);
    expect(claim).not.toHaveBeenCalled(); expect(spies.seek).not.toHaveBeenCalled();
  });
  it.each(['pointercancel', 'lostpointercapture'])('cancels on %s', type => {
    const { slider } = setup();
    pointer(slider, 'pointerdown'); vi.advanceTimersByTime(400); pointer(slider, 'pointermove', 150);
    pointer(type === 'lostpointercapture' ? slider.parentElement! : slider, type); pointer(slider, 'pointerup', 150);
    expect(spies.seek).not.toHaveBeenCalled(); expect(slider).toHaveValue('30');
  });
  it('cancels on track replacement and secondary contact elsewhere', () => {
    const { slider } = setup();
    pointer(slider, 'pointerdown'); vi.advanceTimersByTime(400); pointer(slider, 'pointermove', 150);
    setState('playback', 'currentTrack', { id: 'two' }); pointer(slider, 'pointerup', 150);
    expect(spies.seek).not.toHaveBeenCalled();
    pointer(slider, 'pointerdown'); vi.advanceTimersByTime(400); pointer(slider, 'pointermove', 150);
    pointer(document.body, 'pointerdown', 10, { isPrimary: false, pointerId: 2 }); pointer(slider, 'pointerup', 150);
    expect(spies.seek).not.toHaveBeenCalled();
  });
  it('clamps mouse dragging and supports assistive input without holding', () => {
    const { slider } = setup();
    pointer(slider, 'pointerdown', 100, { pointerType: 'mouse' });
    pointer(slider, 'pointermove', 300, { pointerType: 'mouse' }); pointer(slider, 'pointerup', 300, { pointerType: 'mouse' });
    expect(spies.seek).toHaveBeenLastCalledWith(120);
    fireEvent.input(slider, { target: { value: '45' } });
    expect(spies.seek).toHaveBeenLastCalledWith(45);
  });
  it('disables seeking for unresolved sources or invalid durations', () => {
    const { slider } = setup();
    setState('playback', 'isLoading', true); expect(slider).toBeDisabled();
    setState('playback', { isLoading: false, duration: 0 }); expect(slider).toBeDisabled();
  });
});


it.each(['blur', 'loading', 'duration', 'unmount'])('abandons an edit on %s', reason => {
  const { slider, unmount } = setup();
  pointer(slider, 'pointerdown'); vi.advanceTimersByTime(400); pointer(slider, 'pointermove', 150);
  if (reason === 'blur') fireEvent(window, new Event('blur'));
  if (reason === 'loading') setState('playback', 'isLoading', true);
  if (reason === 'duration') setState('playback', 'duration', 0);
  if (reason === 'unmount') unmount();
  pointer(slider, 'pointerup', 150);
  expect(spies.seek).not.toHaveBeenCalled();
});
