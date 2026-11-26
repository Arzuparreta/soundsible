import { Index, Show } from 'solid-js';
import { Control } from '../design/Control';
import type { AppBarAction } from '../lib/appBar';
import styles from './AppBar.module.css';

export function PageCommands(props: { actions?: AppBarAction[]; desktop?: boolean }) {
  return <Index each={props.actions ?? []}>{action => <ActionButton action={action()} desktop={props.desktop} />}</Index>;
}

function ActionButton(props: { action: AppBarAction; desktop?: boolean }) {
  const worded = () => props.action.prominent || props.desktop;
  return (
    <Control
      class={props.action.prominent ? styles.prominent : worded() ? styles.command : styles.icon}
      data-command-tone={props.action.tone}
      title={worded() ? undefined : props.action.label}
      aria-label={props.action.label}
      aria-busy={props.action.busy || undefined}
      aria-pressed={props.action.pressed}
      aria-expanded={props.action.expanded}
      aria-haspopup={props.action.opensDialog ? 'dialog' : undefined}
      disabled={props.action.disabled}
      data-pressable
      onClick={(event) => props.action.onSelect(event)}
    >
      <Show when={!props.action.prominent}>{props.action.icon()}</Show>
      <Show when={worded()}><span>{props.action.desktopLabel ?? props.action.label}</span></Show>
    </Control>
  );
}
