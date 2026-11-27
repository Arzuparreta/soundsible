import type { MenuEvent } from '../lib/menuEvent';
import { createMemo, Index, Show, type JSX } from 'solid-js';
import { artistDestination, albumDestination, navigateMusic, performerNames, type MusicLinkIntent } from '../lib/musicNavigation';
import { createResponsiveTap } from '../lib/responsiveTap';
import styles from './MusicLinks.module.css';

const sameNames = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((name, index) => name === b[index]);

/** Real hash links preserve copy/open-in-tab, while ordinary taps use the router. */
export function MusicLink(props: { path: string; class?: string; label?: string; onOpen?: (path: string) => void; onMenu?: (event?: MenuEvent) => void; children?: JSX.Element }) {
  const tap = createResponsiveTap({ onTap: (event) => {
    event.stopPropagation();
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (props.onOpen) props.onOpen(props.path);
    else navigateMusic(props.path);
  }, onLongPress: props.onMenu ? () => props.onMenu?.() : undefined });
  return <a href={`#${props.path}`} class={`${styles.link} ${props.class ?? ''}`} draggable={false} aria-label={props.label}
    {...tap} onKeyDown={(event) => event.stopPropagation()}
    onContextMenu={(event) => { event.stopPropagation(); if (props.onMenu) { event.preventDefault(); props.onMenu(event); } }} onAuxClick={(event) => event.stopPropagation()}
    onDragStart={(event) => event.stopPropagation()}>{props.children}</a>;
}

export function ArtistLinks(props: { music: MusicLinkIntent; class?: string; fallback?: JSX.Element }) {
  const names = createMemo(
    () => (props.music.linkable !== false ? performerNames(props.music) : []),
    [],
    { equals: sameNames },
  );
  return (
    <span class={props.class}>
      <Show when={names().length} fallback={props.fallback ?? props.music.artist}>
        <Show
          when={names().length === 1}
          fallback={
            /* By position, not by name: a list row is reused for the next track
               (CollectionRows), and its links should change text, not be rebuilt. */
            <Index each={names()}>{(name, index) => (
              <>
                <Show when={index > 0}>{', '}</Show>
                <MusicLink path={artistDestination(props.music, name())}>{name()}</MusicLink>
              </>
            )}</Index>
          }
        >
          <MusicLink path={artistDestination(props.music, names()[0])}>{names()[0]}</MusicLink>
        </Show>
      </Show>
    </span>
  );
}

export function AlbumLink(props: { music: MusicLinkIntent; class?: string; onMenu?: (event?: MenuEvent) => void; children?: JSX.Element }) {
  return <Show when={props.music.linkable !== false && props.music.album?.trim()}
    fallback={<span class={props.class}>{props.children ?? props.music.album}</span>}>
    <MusicLink path={albumDestination(props.music)} class={props.class} onMenu={props.onMenu}>{props.children ?? props.music.album}</MusicLink>
  </Show>;
}
