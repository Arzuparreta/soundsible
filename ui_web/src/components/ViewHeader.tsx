import { createMemo, Show, type JSX } from 'solid-js';
import { PageCommands } from './PageCommands';
import { PageToolbar } from './PageToolbar';
import { useAppBar, type AppBarAction } from '../lib/appBar';
import { desktopShell } from '../lib/shellLayout';
import styles from './ViewHeader.module.css';

/** Registers the page with the shell and renders its toolbar where the field lives. */
export function ViewHeader(props: {
  title: string;
  meta?: JSX.Element;
  field?: JSX.Element;
  desktopField?: JSX.Element;
  fieldActions?: JSX.Element;
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
  const field = createMemo(() => showDesktop() ? props.desktopField ?? props.field : props.field);
  const meta = () => showDesktop() || field() ? props.meta : undefined;
  const desktopActions = createMemo(() => showDesktop() ? props.actions : undefined);
  const commands = () => showDesktop() && !props.rendersOwnCommands ? props.barActions : undefined;
  const fieldActions = createMemo(() => props.fieldActions);
  const hasActions = createMemo(() => Boolean(fieldActions() || desktopActions() || commands()?.length));
  const actions = () => <Show when={hasActions()}>{desktopActions()}{fieldActions()}<PageCommands actions={commands()} desktop /></Show>;

  if (props.compact) {
    return <header class={styles.header}>
      <div class={styles.heading}>
        <h1 class={styles.title}>{props.title}</h1>
        <Show when={props.meta}><span class={styles.meta}>{props.meta}</span></Show>
      </div>
      <Show when={hasActions()}><div class={styles.actions}>{actions()}</div></Show>
    </header>;
  }

  return <Show when={field() || meta() || hasActions()}>
    <PageToolbar field={field()} meta={meta()} actions={hasActions() ? actions() : undefined} />
  </Show>;
}
