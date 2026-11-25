import { Show, type JSX } from 'solid-js';
import { desktopShell } from '../lib/shellLayout';
import type { CollectionSearchState } from './CollectionSearch';
import { PageToolbar } from './PageToolbar';
import { SearchField } from './SearchField';

/** The touch shell renders the field under its app bar. Desktop draws it here. */
export function CollectionToolbar(props: {
  search: CollectionSearchState;
  contained?: boolean;
  actions?: JSX.Element;
  meta?: JSX.Element;
}) {
  return <Show when={desktopShell() || props.actions}>
    <PageToolbar contained={props.contained}
      field={desktopShell() ? <SearchField {...props.search.reveal.field()} inputRef={props.search.reveal.attachInput} /> : undefined}
      meta={desktopShell() ? props.meta : undefined} actions={props.actions} />
  </Show>;
}
