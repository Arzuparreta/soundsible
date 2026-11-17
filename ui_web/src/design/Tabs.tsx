import { For } from 'solid-js';
import { Control } from './Control';

export function Tabs<T extends string>(props: {
  label: string;
  value: T;
  items: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  class?: string;
  activeClass?: string;
}) {
  return <div role="tablist" aria-label={props.label} class={props.class}>
    <For each={props.items}>{(item, index) => <Control role="tab"
      class={props.value === item.value ? props.activeClass : undefined}
      aria-selected={props.value === item.value} tabindex={props.value === item.value ? 0 : -1}
      onClick={() => props.onChange(item.value)} onKeyDown={event => {
        const last = props.items.length - 1;
        const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
        const step = event.key === 'ArrowRight' ? (rtl ? -1 : 1) : event.key === 'ArrowLeft' ? (rtl ? 1 : -1) : 0;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? last
          : step ? (index() + step + props.items.length) % props.items.length : -1;
        if (next < 0) return;
        event.preventDefault();
        props.onChange(props.items[next].value);
        event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
      }}>{item.label}</Control>}</For>
  </div>;
}
