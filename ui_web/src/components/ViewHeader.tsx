import { createMemo, Show, type JSX } from 'solid-js';
import { PageCommands } from './AppBar';
import { createResponsiveTap } from '../lib/responsiveTap';
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
  /** On desktop the page renders `barActions` itself, next to its own field,
   * so the header leaves them out. Touch still gets them in the top bar. */
  rendersOwnCommands?: boolean;
  /** A native control the top bar carries as is — a dropdown keeps its
   * platform keyboard behaviour that a described command would lose. */
  barTrailing?: JSX.Element;
  onViewChange?: () => void;
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
  const extra = createMemo(() => showDesktop() ? props.children : undefined);
  const commands = () => props.rendersOwnCommands ? undefined : props.barActions;
  return (
    <Show when={props.compact || (desktopShell() && (props.meta || actions() || extra() || field() || commands()?.length))}>
      <header class={styles.header} data-compact={props.compact ? '' : undefined}>
        <div class={styles.heading} data-toolbar-field={field() ? '' : undefined}>
          {field()}
          <Show when={props.compact}>
            <h1 class={styles.title}>
              <Show when={props.onTitleTap} fallback={props.title}>
                <button type="button" class={styles.titleButton} data-pressable {...tap}>{props.title}</button>
              </Show>
            </h1>
          </Show>
          <Show when={props.meta}>
            <span class={styles.meta}>{props.meta}</span>
          </Show>
        </div>
        <Show when={actions() || extra() || commands()?.length}>
          <div class={styles.actions}>{actions()}{extra()}<PageCommands actions={commands()} desktop /></div>
        </Show>
      </header>
    </Show>
  );
}
