import { createSignal } from 'solid-js';

const [pageVisible, setPageVisible] = createSignal(true);
export { pageVisible };

/** Presentation only: losing focus is not the same as being hidden. Audio,
 * DJ scheduling and Media Session must never depend on this signal. */
export function installPageVisibility(): () => void {
  const root = document.documentElement;
  const update = () => {
    const visible = document.visibilityState !== 'hidden';
    setPageVisible(visible);
    root.toggleAttribute('data-page-hidden', !visible);
  };
  update();
  document.addEventListener('visibilitychange', update);
  window.addEventListener('pageshow', update);
  return () => {
    document.removeEventListener('visibilitychange', update);
    window.removeEventListener('pageshow', update);
    root.removeAttribute('data-page-hidden');
    setPageVisible(true);
  };
}
