import { createMemo, Show, type JSX } from 'solid-js';
import { PageCommands } from './PageCommands';
import type { SearchRevealState } from './SearchReveal';
import { PageToolbar } from './PageToolbar';
import { useAppBar, type AppBarAction } from '../lib/appBar';
import { desktopShell } from '../lib/shellLayout';
import styles from './ViewHeader.module.css';

/** Registers the page with the shell and renders its toolbar where the field lives. */
export function ViewHeader(props: {
  title: string;
  meta?: JSX.Element;
  field?: JSX.Element;
  search?: SearchRevealState;
  actions?: JSX.Element;
  barActions?: AppBarAction[];
  /** On desktop the page draws whichever of its commands it wants next to
   * its own field (a field can replace a search command), so the header
   * leaves `barActions` out. Touch still gets them all in the top bar. */
  rendersOwnCommands?: boolean;
  /** A native control both toolbars carry as is, preserving its keyboard behavior. */
  trailing?: JSX.Element;
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
      search: () => props.search,
      trailing: () => props.trailing,
      get onTitleTap() { return props.onTitleTap; },
    });
  }

  const showDesktop = () => props.compact || desktopShell();
  const field = createMemo(() => {
    const search = props.search;
    return showDesktop() && search ? search.desktopField() : props.field;
  });
  const meta = () => showDesktop() || field() ? props.meta : undefined;
  const desktopActions = createMemo(() => showDesktop() ? props.actions : undefined);
  const commands = () => showDesktop() && !props.rendersOwnCommands ? props.barActions : undefined;
  const trailing = createMemo(() => showDesktop() ? props.trailing : undefined);
  const hasActions = createMemo(() => Boolean(trailing() || desktopActions() || commands()?.length));
  const actions = () => <Show when={hasActions()}>{desktopActions()}{trailing()}<PageCommands actions={commands()} desktop /></Show>;

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
