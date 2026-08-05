import { createSignal, type JSX } from 'solid-js';
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
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

describe('scroll history', () => {
  beforeEach(() => {
    resetScrollHistoryForTests();
    window.history.replaceState(null, '', '/#/a');
  });

  afterEach(() => {
    resetScrollHistoryForTests();
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
    await waitFor(() => expect(window.history.state?.__soundsibleScroll?.id).toBeTruthy());
    original.scrollTop = 240;
    fireEvent.scroll(original);

    fireEvent.click(screen.getByRole('button', { name: 'Open B' }));
    await screen.findByRole('button', { name: 'Back' });
    await waitFor(() => expect(window.location.hash).toBe('#/b'));

    setReady(false);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    const restored = await screen.findByTestId('scroll-a');
    expect(restored.scrollTop).toBe(0);

    setReady(true);
    // Restoration waits for the list to report it has content, then for a frame.
    // A loaded CI runner can spend longer than testing-library's default second
    // on that, and the failure it produces — scrollTop still 0 — looks exactly
    // like the regression this test is for.
    await waitFor(() => expect(restored.scrollTop).toBe(240), { timeout: 5_000 });
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
    await waitFor(() => expect(window.history.state?.__soundsibleScroll?.id).toBeTruthy());
    original.scrollTop = 180;
    fireEvent.scroll(original);

    fireEvent.click(screen.getByRole('button', { name: 'Open B' }));
    await screen.findByRole('button', { name: 'Open new A' });
    fireEvent.click(screen.getByRole('button', { name: 'Open new A' }));

    const fresh = await screen.findByTestId('scroll-a');
    await waitFor(() => expect(fresh.scrollTop).toBe(0));
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
