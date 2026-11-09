import { Show, type JSX } from 'solid-js';
import { createResponsiveTap } from '../lib/responsiveTap';
import { useAppBar, type AppBarAction } from '../lib/appBar';
import { desktopShell } from '../lib/shellLayout';
import styles from './ViewHeader.module.css';

/**
 * A page's header. On the desktop shell it is drawn here, in the page; on the
 * touch shell the page's title and commands go up into the shell's top bar
 * (`AppBar`), which is the only header a phone ever shows — `barActions` are
 * the commands it carries there, since a toolbar of worded buttons is desktop
 * furniture. `compact` headers belong to panels inside the player, not to a
 * page, and always draw in place.
 */
export function ViewHeader(props: {
  title: string;
  meta?: JSX.Element;
  actions?: JSX.Element;
  barActions?: AppBarAction[];
  /** A native control the top bar carries as is — a dropdown keeps its
   * platform keyboard behaviour that a described command would lose. */
  barTrailing?: JSX.Element;
  children?: JSX.Element;
  compact?: boolean;
  onTitleTap?: () => void;
}) {
  const tap = createResponsiveTap({
    onTap: () => props.onTitleTap?.(),
  });

  if (!props.compact) {
    useAppBar({
      title: () => props.title,
      actions: () => props.barActions ?? [],
      trailing: () => props.barTrailing,
      onTitleTap: props.onTitleTap,
    });
  }

  return (
    <Show when={props.compact || desktopShell()}>
      <header class={styles.header} data-compact={props.compact ? '' : undefined}>
        <div class={styles.heading}>
          <Show
            when={props.onTitleTap}
            fallback={<h1 class={styles.title}>{props.title}</h1>}
          >
            <h1 class={styles.title}>
              <button type="button" class={styles.titleButton} data-pressable {...tap}>
                {props.title}
              </button>
            </h1>
          </Show>
          <Show when={props.meta}>
            <span class={styles.meta}>{props.meta}</span>
          </Show>
        </div>
        <Show when={props.actions || props.children}>
          <div class={styles.actions}>{props.actions}{props.children}</div>
        </Show>
      </header>
    </Show>
  );
}
