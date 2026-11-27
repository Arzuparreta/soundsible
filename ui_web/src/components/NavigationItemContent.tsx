import type { JSX } from 'solid-js';
import styles from './NavigationMenu.module.css';

export function NavigationItemContent(props: {
  icon: () => JSX.Element;
  label: string;
  collapsed?: boolean;
}) {
  return (
    <>
      <span class={styles.icon}>{props.icon()}</span>
      <span class={styles.label} hidden={props.collapsed}>{props.label}</span>
    </>
  );
}
