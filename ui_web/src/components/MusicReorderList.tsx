import { createSignal, For, type JSX } from 'solid-js';
import { t } from '../lib/i18n';
import styles from './NowPlayingBrowser.module.css';

/** Explicit edit-mode ordering, shared by playlists and their occurrences. */
export function MusicReorderList<T>(props: {
  items: T[];
  label: (item: T) => string;
  render: (item: T) => JSX.Element;
  onChange: (items: T[]) => Promise<unknown>;
}) {
  const [busy, setBusy] = createSignal(false);
  let dragged: number | null = null;
  const move = async (from: number, to: number) => {
    if (busy() || from === to || to < 0 || to >= props.items.length) return;
    const next = [...props.items];
    next.splice(to, 0, next.splice(from, 1)[0]);
    setBusy(true);
    try { await props.onChange(next); } finally { setBusy(false); }
  };
  return <div aria-busy={busy()}><For each={props.items}>{(item, index) => <div class={styles.editRow}
    draggable={!busy()} onDragStart={(event) => { dragged = index(); event.stopPropagation(); event.dataTransfer?.setData('text/plain', props.label(item)); }}
    onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); if (dragged !== null) void move(dragged, index()); dragged = null; }} onDragEnd={() => { dragged = null; }}>
    <div>{props.render(item)}</div>
    <button type="button" disabled={busy() || index() === 0} aria-label={`${t('musicExplorer.up')}: ${props.label(item)}`} onClick={() => void move(index(), index() - 1)}>↑</button>
    <button type="button" disabled={busy() || index() === props.items.length - 1} aria-label={`${t('musicExplorer.down')}: ${props.label(item)}`} onClick={() => void move(index(), index() + 1)}>↓</button>
  </div>}</For></div>;
}
