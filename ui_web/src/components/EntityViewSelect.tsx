import { For } from 'solid-js';
import styles from './EntityHero.module.css';

/** The collection currently shown and played, with native keyboard and touch selection. */
export function EntityViewSelect(props: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return <select class={styles.viewSelect} aria-label={props.label} value={props.value}
    onChange={event => props.onChange(event.currentTarget.value)}>
    <For each={props.options}>{option => <option value={option.value} selected={props.value === option.value}>{option.label}</option>}</For>
  </select>;
}
