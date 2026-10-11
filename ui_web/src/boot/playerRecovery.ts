import type { Component } from 'solid-js';

// Keep import.meta.glob outside JSX: Vite's dependency scanner strips TS
// from glob modules and then parses the result as plain JavaScript.
// WebKit recovery still needs a distinct URL after a rejected module fetch.
export const recoveryPlayer = import.meta.glob<Component>('../AuthenticatedPlayer.tsx', {
  query: '?recovery', import: 'default',
})['../AuthenticatedPlayer.tsx'];
