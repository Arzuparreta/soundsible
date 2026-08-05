import { createSignal, type JSX } from 'solid-js';
import { fireEvent, render, screen } from '@solidjs/testing-library';
import { HashRouter, Route, useNavigate, type RouteSectionProps } from '@solidjs/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ScrollHistoryManager,
  navigateBackOr,
  registerPrimaryScroll,
  resetScrollHistoryForTests,
} from './scrollHistory';

function RouterShell(props: RouteSectionProps): JSX.Element {
  return (
    <>
      <ScrollHistoryManager />
      {props.children}
    </>
  );
}

/**
 * Scroll history schedules its work on animation frames, so these tests own the
 * frame clock instead of racing it.
 *
 * Waiting on real frames is what made this file flaky: on a loaded runner the
 * restore did not land inside the budget, the assertion read `scrollTop` as 0,
 * and that is indistinguishable from the regression the test exists to catch. A
 * green run meant "the runner was quick enough today", which is not a claim
 * worth blocking a merge on.
 *
 * Driving the frames explicitly asserts the same behaviour — that restoration
 * happens on a frame, after the surface reports ready — and asserts it the same
 * way on every machine.
 */
function installManualFrames() {
  let nextHandle = 1;
  const pending = new Map<number, FrameRequestCallback>();

  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;

  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const handle = nextHandle;
    nextHandle += 1;
    pending.set(handle, callback);
    return handle;
  }) as typeof globalThis.requestAnimationFrame;

  globalThis.cancelAnimationFrame = ((handle: number) => {
    pending.delete(handle);
  }) as typeof globalThis.cancelAnimationFrame;

  return {
    /**
     * Run every queued frame, then let microtasks settle, repeatedly — a frame
     * callback is allowed to schedule the next one, and Solid's effects land in
     * between. Bounded so a callback that reschedules itself forever fails the
     * test instead of hanging it.
     */
    async flush(rounds = 12): Promise<void> {
      for (let round = 0; round < rounds; round += 1) {
        if (pending.size === 0) {
          await Promise.resolve();
          if (pending.size === 0) return;
        }
        const due = [...pending.entries()];
        pending.clear();
        for (const [, callback] of due) callback(performance.now());
        await Promise.resolve();
      }
    },
    restore(): void {
      globalThis.requestAnimationFrame = originalRequest;
      globalThis.cancelAnimationFrame = originalCancel;
    },
  };
}

describe('scroll history', () => {
  let frames: ReturnType<typeof installManualFrames>;

  beforeEach(() => {
    frames = installManualFrames();
    resetScrollHistoryForTests();
    window.history.replaceState(null, '', '/#/a');
  });

  afterEach(() => {
    resetScrollHistoryForTests();
    frames.restore();
  });

  it('restores a traversed entry once its asynchronous surface is ready', async () => {
    const [ready, setReady] = createSignal(true);

    function A() {
      const navigate = useNavigate();
      return (
        <>
          <button onClick={() => navigate('/b')}>Open B</button>
          <div
            data-testid="scroll-a"
            ref={(element) => registerPrimaryScroll(element, ready)}
          />
        </>
      );
    }

    function B() {
      const navigate = useNavigate();
      return <button onClick={() => navigate(-1)}>Back</button>;
    }

    render(() => (
      <HashRouter root={RouterShell}>
        <Route path="/a" component={A} />
        <Route path="/b" component={B} />
      </HashRouter>
    ));

    const original = await screen.findByTestId('scroll-a');
    await frames.flush();
    expect(window.history.state?.__soundsibleScroll?.id).toBeTruthy();
    original.scrollTop = 240;
    fireEvent.scroll(original);

    fireEvent.click(screen.getByRole('button', { name: 'Open B' }));
    await screen.findByRole('button', { name: 'Back' });
    await frames.flush();
    expect(window.location.hash).toBe('#/b');

    setReady(false);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    const restored = await screen.findByTestId('scroll-a');
    await frames.flush();
    // Still at the top: the surface has not reported that its content is there,
    // so restoring now would scroll against a page of the wrong height.
    expect(restored.scrollTop).toBe(0);

    setReady(true);
    await frames.flush();
    expect(restored.scrollTop).toBe(240);
  });

  it('starts a fresh visit at the top even when the URL existed earlier', async () => {
    function A() {
      const navigate = useNavigate();
      return (
        <>
          <button onClick={() => navigate('/b')}>Open B</button>
          <div data-testid="scroll-a" ref={(element) => registerPrimaryScroll(element)} />
        </>
      );
    }

    function B() {
      const navigate = useNavigate();
      return <button onClick={() => navigate('/a')}>Open new A</button>;
    }

    render(() => (
      <HashRouter root={RouterShell}>
        <Route path="/a" component={A} />
        <Route path="/b" component={B} />
      </HashRouter>
    ));

    const original = await screen.findByTestId('scroll-a');
    await frames.flush();
    expect(window.history.state?.__soundsibleScroll?.id).toBeTruthy();
    original.scrollTop = 180;
    fireEvent.scroll(original);

    fireEvent.click(screen.getByRole('button', { name: 'Open B' }));
    await screen.findByRole('button', { name: 'Open new A' });
    await frames.flush();
    fireEvent.click(screen.getByRole('button', { name: 'Open new A' }));

    const fresh = await screen.findByTestId('scroll-a');
    await frames.flush();
    expect(fresh.scrollTop).toBe(0);
  });

  it('uses a canonical fallback only for a directly opened detail', async () => {
    const navigate = vi.fn();
    navigateBackOr(navigate, '/search');
    expect(navigate).toHaveBeenCalledWith('/search', { replace: true });

    window.history.replaceState({
      __soundsibleScroll: { id: 'detail', parentId: 'search' },
    }, '');
    navigate.mockClear();
    navigateBackOr(navigate, '/search');
    expect(navigate).toHaveBeenCalledWith(-1);
  });
});
