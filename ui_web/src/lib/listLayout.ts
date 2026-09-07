import { createSignal } from 'solid-js';

// One subscription for every virtual row. Keep this breakpoint independent of
// the shell's large-interface sidebar decision, just like the list CSS tokens.
const media = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(max-width: 1023px)') : undefined;
const [mobile, setMobile] = createSignal(media?.matches ?? false);
media?.addEventListener('change', (event) => setMobile(event.matches));
export const mobileListLayout = mobile;
