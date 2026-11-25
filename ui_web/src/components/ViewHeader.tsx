import { createMemo, Show, type JSX } from 'solid-js';
import { PageCommands } from './AppBar';
import { useAppBar, type AppBarAction } from '../lib/appBar';
import { desktopShell } from '../lib/shellLayout';
import styles from './ViewHeader.module.css';

/** Page toolbar on desktop, shell commands on touch. Compact panels have their own heading. */
export function ViewHeader(props: {
  title: string;
  meta?: JSX.Element;
  desktopField?: JSX.Element;
  actions?: JSX.Element;
  barActions?: AppBarAction[];
  /** On desktop the page draws whichever of its commands it wants next to
   * its own field (a field can replace a search command), so the header
   * leaves `barActions` out. Touch still gets them all in the top bar. */
  rendersOwnCommands?: boolean;
  /** A native control the top bar carries as is — a dropdown keeps its
   * platform keyboard behaviour that a described command would lose. */
  barTrailing?: JSX.Element;
  onViewChange?: () => void;
  compact?: boolean;
  onTitleTap?: () => void;
}) {
  if (!props.compact) {
    useAppBar({
      title: () => props.title,
      indicator: true,
      get onViewChange() { return props.onViewChange; },
      actions: () => props.barActions ?? [],
      trailing: () => props.barTrailing,
      get onTitleTap() { return props.onTitleTap; },
    });
  }

  const showDesktop = () => props.compact || desktopShell();
  const field = createMemo(() => showDesktop() ? props.desktopField : undefined);
  const actions = createMemo(() => showDesktop() ? props.actions : undefined);
  const commands = () => props.rendersOwnCommands ? undefined : props.barActions;
  return (
    <Show when={props.compact || (desktopShell() && (props.meta || actions() || field() || commands()?.length))}>
      <header class={styles.header} data-compact={props.compact ? '' : undefined}>
        <div class={styles.heading} data-toolbar-field={field() ? '' : undefined}>
          {field()}
          <Show when={props.compact}>
            <h1 class={styles.title}>{props.title}</h1>
          </Show>
          <Show when={props.meta}>
            <span class={styles.meta}>{props.meta}</span>
          </Show>
        </div>
        <Show when={actions() || commands()?.length}>
          <div class={styles.actions}>{actions()}<PageCommands actions={commands()} desktop /></div>
        </Show>
      </header>
    </Show>
  );
}
