/**
 * Shared inline glyphs. Icons live next to their button in most of this
 * codebase; the ones here earned a home because the same drawing appears in
 * several places and drifting copies would read as different affordances.
 */

/** Handheld karaoke mic — the "show lyrics" affordance. */
export function KaraokeMicIcon(props: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={props.size}
      height={props.size}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {/* Drawn upright, then tilted: a mic held at an angle reads as singing
          along, while the same glyph stood on end reads as dictation. */}
      <g transform="rotate(40 12 12)">
        <rect x="9" y="2.6" width="6" height="10" rx="3" />
        <path d="M12 12.6V20" />
        <path d="M10.4 16.6h3.2" />
      </g>
    </svg>
  );
}
