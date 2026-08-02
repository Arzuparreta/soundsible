/**
 * Shared inline glyphs. Icons live next to their button in most of this
 * codebase; the ones here earned a home because the same drawing appears in
 * several places and drifting copies would read as different affordances.
 */

/** Handheld karaoke mic — round mesh head on a tapered body, the
 * "show lyrics" affordance. */
export function KaraokeMicIcon(props: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={props.size}
      height={props.size}
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path
        d="M12 3
           C9.8 3 7.8 5.3 7.8 8.2
           C7.8 10.3 8.9 11.6 9.6 12.3
           L9.3 19
           C9.25 20.2 9.9 21 11 21
           L13 21
           C14.1 21 14.75 20.2 14.7 19
           L14.4 12.3
           C15.1 11.6 16.2 10.3 16.2 8.2
           C16.2 5.3 14.2 3 12 3
           Z"
      />
      <path d="M9.2 6.4h5.6" />
      <path d="M9 8.3h6" />
    </svg>
  );
}
