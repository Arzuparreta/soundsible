import { createSignal, onCleanup, type JSX } from 'solid-js';

/**
 * One command in the top bar's trailing slot.
 *
 * Commands are described, not drawn: the bar decides their size, spacing,
 * colour and feedback, so every page's buttons are the same buttons.
 */
export interface AppBarAction {
  label: string;
  icon: () => JSX.Element;
  onSelect: (event: MouseEvent) => void;
  /** A count worn on the icon — active downloads, for instance. */
  badge?: number;
  disabled?: boolean;
  /** Set when the command opens a menu or a sheet rather than acting. */
  opensDialog?: boolean;
  /**
   * The page's one primary command, spelled out as an accent pill instead of
   * an icon. At most one per page — two pills in a bar is a toolbar.
   */
  prominent?: boolean;
}

/**
 * What a page puts in the top bar. Every field is read reactively, so a page
 * describes its bar once and the bar follows the page's own state.
 */
export interface AppBarConfig {
  title: () => string;
  /** A detail page returns with this instead of opening the menu. */
  back?: () => void;
  backLabel?: () => string;
  actions?: () => AppBarAction[];
  /**
   * The page's own large title, when it draws one — an album cover's heading.
   * The bar then carries the title only once that heading scrolls out of
   * sight, which keeps one visible title on screen at a time.
   */
  heading?: () => HTMLElement | undefined;
  /** Tapping the title. Defaults to returning the page to its top. */
  onTitleTap?: () => void;
  /** The navigation drawer switched library views on the page's behalf. */
  onViewChange?: () => void;
}

const [stack, setStack] = createSignal<readonly AppBarConfig[]>([]);

/**
 * The page on screen owns the bar. A stack rather than a slot, because the
 * router mounts the incoming route before it disposes the outgoing one: the
 * newest registration wins, and a departing page removes only its own.
 */
export const currentAppBar = (): AppBarConfig | undefined => stack().at(-1);

/** Declare the calling page's top bar for as long as the page is mounted. */
export function useAppBar(config: AppBarConfig): void {
  setStack((entries) => [...entries, config]);
  onCleanup(() => setStack((entries) => entries.filter((entry) => entry !== config)));
}
