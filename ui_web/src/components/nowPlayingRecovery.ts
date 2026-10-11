// A JSX-free module lets Vite scan this alternate recovery URL as plain JS.
export const recoverNowPlaying = import.meta.glob<typeof import('./NowPlaying').NowPlaying>('./NowPlaying.tsx', {
  query: '?recovery', import: 'NowPlaying',
})['./NowPlaying.tsx'];
