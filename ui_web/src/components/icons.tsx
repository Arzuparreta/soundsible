import type { JSX } from 'solid-js';

/**
 * Shared inline glyphs. Icons live next to their button in most of this
 * codebase; the ones here earned a home because the same drawing appears in
 * several places and drifting copies would read as different affordances.
 *
 * Every verb a menu or a button offers has exactly one drawing, here: a song's
 * "Descargar" is the same arrow in a row, in its menu and on a podcast episode,
 * and "Cambiar la sesión" is the same swap wherever DJ offers it.
 */

export interface GlyphProps {
  /** Pixel box. Omitted, the host's CSS sizes it (rows size their slot). */
  size?: number;
  class?: string;
}

/** The house line glyph: 24-unit grid, 2-unit stroke, round ends and joins —
 * the Lucide grammar the rest of the interface is drawn in. */
function Glyph(props: GlyphProps & { children: JSX.Element; strokeWidth?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={props.size}
      height={props.size}
      fill="none"
      stroke="currentColor"
      stroke-width={props.strokeWidth ?? 2}
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

const line = (d: string) => (props: GlyphProps) => <Glyph {...props}><path d={d} /></Glyph>;

/** Radio mode: a portable set — antenna, speaker grille, tuning dial. Drawn
 * as the object on purpose; the old broadcast arcs read as Wi-Fi or a signal
 * meter, and nobody guessed "start a radio" from them. */
export function RadioIcon(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="3" y="9" width="18" height="12" rx="2" />
      <path d="m7 9 10-6M15 13h3M15 17h3" />
      <circle cx="9" cy="15" r="3" />
    </Glyph>
  );
}

/** Throw the session away and start it again from this music — the two
 * directions trading places. Distinct from `SourceIcon`, which keeps the
 * session and only turns it. */
export const ChangeSessionIcon = line('m16 3 4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16');

export const PlayIcon = line('m7 4 12 8-12 8z');
export const ShuffleIcon = line('M16 3h5v5M21 3l-7 7M4 20l7-7M16 21h5v-5M4 4l5 5');
export const RepeatIcon = line('M17 2l4 4-4 4M3 11V9a4 4 0 014-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 01-4 4H3');
export const PlayNextIcon = line('M5 4v16M9 5l8 7-8 7z');
/** "A list, plus one": the queue outside DJ, the route inside it. */
export const QueueAddIcon = line('M3 6h13M3 12h9M3 18h9M16 14v6M19 17h-6');
export const PlaylistIcon = line('M3 6h13M3 12h9M3 18h7M17 12v7M21 14l-4-2v7');
export const ArtistIcon = line('M16 19a4 4 0 00-8 0M12 11a3 3 0 100-6 3 3 0 000 6M12 2a10 10 0 100 20 10 10 0 000-20');
/** A record: the album, wherever a menu leads to one. */
export function AlbumIcon(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2.5" />
    </Glyph>
  );
}
export const HeartIcon = line('M12 21s-7-4.35-9.5-8.5C.9 9.6 2.2 6 5.5 6 7.6 6 9 7.5 12 10c3-2.5 4.4-4 6.5-4 3.3 0 4.6 3.6 3 6.5C19 16.65 12 21 12 21z');
export const EditIcon = line('M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z');
export const RenameIcon = line('M4 7V4h16v3M9 20h6M12 4v16');
export function DuplicateIcon(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="8" y="8" width="13" height="13" rx="2" />
      <path d="M4 16V6a2 2 0 012-2h10" />
    </Glyph>
  );
}
export function CoverIcon(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-5-5L5 21" />
    </Glyph>
  );
}
export const ShareIcon = line('M4 12v8h16v-8M12 16V3M8 7l4-4 4 4');
export function DeviceIcon(props: GlyphProps) {
  return (
    <Glyph {...props}>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </Glyph>
  );
}
/** Save to the library: claim the song, no file yet. */
export const SaveIcon = line('M12 5v14M5 12h14');
/** Take something out of a collection it was added to — the library, a
 * playlist, the queue, the route. Never deletes a file; `TrashIcon` does. */
export const RemoveIcon = line('M5 12h14');
/** Put the bytes on disk. The same arrow on rows, menus and episodes. */
export const DownloadIcon = line('M12 3v12m0 0 4-4m-4 4-4-4M5 20h14');
/** Done, owned, subscribed: a statement, not an offer. */
export const CheckIcon = (props: GlyphProps) => <Glyph {...props} strokeWidth={2.5}><path d="m5 12 5 5L20 7" /></Glyph>;
export const TrashIcon = line('M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14');
export const MoveIcon = line('m7 15 5 5 5-5M7 9l5-5 5 5');
/** Leave for the page this thing lives on. */
export const OpenIcon = line('M7 17 17 7M7 7h10v10');
export const FeedbackIcon = line('M17 14V4M9 18.5l1-4.5H4.5a2 2 0 01-1.9-2.6l2-6A2 2 0 016.5 4H17v10l-4 7a2 2 0 01-4-2.5z');
export const InfoIcon = line('M12 17v-6M12 7h.01M12 2a10 10 0 100 20 10 10 0 000-20');
/** Subscribe to a show: a plus, the same "claim it" as saving a song. */
export const SubscribeIcon = SaveIcon;

/* The top bar's own verbs (AppBar.tsx). One drawing each, so "back" on an
 * album is the same chevron as "back" in a settings section. */
export const MenuIcon = line('M4 6h16M4 12h16M4 18h16');
export const BackIcon = line('m15 18-6-6 6-6');
export const CloseIcon = line('M18 6 6 18M6 6l12 12');
export const SearchIcon = (props: GlyphProps) => <Glyph {...props}><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></Glyph>;
export const SortIcon = line('M3 6h18M6 12h12M10 18h4');
export const MoreIcon = (props: GlyphProps) => <Glyph {...props}><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></Glyph>;
export const BroadcastIcon = line('M8.5 8.5a5 5 0 000 7M15.5 8.5a5 5 0 010 7M5.6 5.6a9 9 0 000 12.8M18.4 5.6a9 9 0 010 12.8M12 12h.01');

/** Menu-sized glyphs. Action sheets and context menus hold one per row, all at
 * the same box, so every builder reaches for the same set. */
const MENU = 20;
export const menuIcons = {
  play: () => <PlayIcon size={MENU} />,
  shuffle: () => <ShuffleIcon size={MENU} />,
  repeat: () => <RepeatIcon size={MENU} />,
  playNext: () => <PlayNextIcon size={MENU} />,
  queue: () => <QueueAddIcon size={MENU} />,
  playlist: () => <PlaylistIcon size={MENU} />,
  radio: () => <RadioIcon size={MENU} />,
  source: () => <SourceIcon size={MENU} />,
  changeSession: () => <ChangeSessionIcon size={MENU} />,
  artist: () => <ArtistIcon size={MENU} />,
  album: () => <AlbumIcon size={MENU} />,
  heart: () => <HeartIcon size={MENU} />,
  edit: () => <EditIcon size={MENU} />,
  rename: () => <RenameIcon size={MENU} />,
  duplicate: () => <DuplicateIcon size={MENU} />,
  cover: () => <CoverIcon size={MENU} />,
  share: () => <ShareIcon size={MENU} />,
  device: () => <DeviceIcon size={MENU} />,
  save: () => <SaveIcon size={MENU} />,
  remove: () => <RemoveIcon size={MENU} />,
  download: () => <DownloadIcon size={MENU} />,
  check: () => <CheckIcon size={MENU} />,
  trash: () => <TrashIcon size={MENU} />,
  move: () => <MoveIcon size={MENU} />,
  open: () => <OpenIcon size={MENU} />,
  feedback: () => <FeedbackIcon size={MENU} />,
  info: () => <InfoIcon size={MENU} />,
  subscribe: () => <SubscribeIcon size={MENU} />,
};

/** Handheld stage mic — tilted, ring grille on a tapered body. Adapted
 * from Phosphor Icons' "microphone-stage" (MIT). The "show lyrics"
 * affordance. */
export function KaraokeMicIcon(props: { size?: number }) {
  return (
    <svg
      viewBox="0 0 256 256"
      width={props.size}
      height={props.size}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M168,16A72.07,72.07,0,0,0,96,88a73.29,73.29,0,0,0,.63,9.42L27.12,192.22A15.93,15.93,0,0,0,28.71,213L43,227.29a15.93,15.93,0,0,0,20.78,1.59l94.81-69.53A73.29,73.29,0,0,0,168,160a72,72,0,1,0,0-144Zm56,72a55.72,55.72,0,0,1-11.16,33.52L134.49,43.16A56,56,0,0,1,224,88ZM54.32,216,40,201.68,102.14,117A72.37,72.37,0,0,0,139,153.86ZM112,88a55.67,55.67,0,0,1,11.16-33.51l78.34,78.34A56,56,0,0,1,112,88Zm-2.35,58.34a8,8,0,0,1,0,11.31l-8,8a8,8,0,1,1-11.31-11.31l8-8A8,8,0,0,1,109.67,146.33Z" />
    </svg>
  );
}

/** Take the session in this song's direction — a heading swept around a fixed
 * point. Auto Mode's one native verb, on the route rows, the transport chip and
 * the stage of the song currently on air. */
export function SourceIcon(props: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={props.size ?? 18}
      height={props.size ?? 18}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="1.6" />
      <path d="M12 4a8 8 0 0 1 8 8M12 20a8 8 0 0 1-8-8" />
    </svg>
  );
}

/** Downward chevron — the "this title opens a menu" mark. Lucide's
 * "chevron-down" (ISC): 45° arms with rounded joins, which reads as a control
 * at text size where the sharper `⌄` glyph reads as a stray character and
 * sits wherever its font decides. Unsized on purpose: the caller gives it an
 * `em` box so it tracks the text it follows across the interface scales. */
export function ChevronDownIcon(props: { class?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
