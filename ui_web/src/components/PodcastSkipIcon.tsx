/** A time jump, distinct from the track navigation glyph. */
export function PodcastSkipIcon(props: { backward?: boolean; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={props.size ?? 30} height={props.size ?? 30} aria-hidden="true">
      <g transform={props.backward ? undefined : 'translate(24 0) scale(-1 1)'} fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 8a9 9 0 1 1-1 8M4 3v5h5" />
      </g>
      <text x="12" y="16" text-anchor="middle" fill="currentColor" font-size="9" font-weight="700">15</text>
    </svg>
  );
}
