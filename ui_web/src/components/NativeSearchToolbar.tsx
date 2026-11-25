import { Show, type JSX } from 'solid-js';
import { scrollableAncestor } from '../lib/scrollableAncestor';
import { PageCommands } from './PageCommands';
import type { SearchRevealState } from './SearchReveal';
import styles from './SearchReveal.module.css';

function section(field: HTMLElement) {
  return field.closest('[data-native-search-scope]') ?? field.closest('section');
}

function nativeScrollScope(field: HTMLElement) {
  return field.closest<HTMLElement>('[role="dialog"], main');
}

/** Native sections have their own headings and don't use the web app bar. */
export function NativeSearchToolbar(props: { search?: SearchRevealState; actions?: JSX.Element }) {
  return <>
    <Show when={props.search || props.actions}>
      <div class={styles.nativeActions}><PageCommands actions={props.search ? [props.search.action()] : []} />{props.actions}</div>
    </Show>
    <Show when={props.search} keyed>{search => search.mobileField({
      contained: true,
      scope: nativeScrollScope,
      scroller: (field, target) => {
        const scope = nativeScrollScope(field);
        if (target && section(field)?.contains(target)) {
          return scrollableAncestor(target, scope?.parentElement ?? undefined) ?? scope;
        }
        return scrollableAncestor(field, scope?.parentElement ?? undefined) ?? scope;
      },
      containsTouch: (field, target) => Boolean(section(field)?.contains(target)),
    })}</Show>
  </>;
}
