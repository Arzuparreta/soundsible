import { MemoryRouter, Route } from '@solidjs/router';
import type { JSX } from 'solid-js';
import { AppBar } from './AppBar';

/**
 * Test harness: a page under the shell's top bar. On the touch shell a page's
 * title, back button and commands are drawn by `AppBar`, so a test that
 * renders a page on its own has to bring the bar along to see them.
 */
export function InShell(props: { children: JSX.Element }) {
  return (
    <MemoryRouter root={(root) => <main><AppBar /><div data-app-outlet>{root.children}</div></main>}>
      <Route path="*" component={() => <>{props.children}</>} />
    </MemoryRouter>
  );
}
