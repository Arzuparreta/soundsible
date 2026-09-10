import { For, Show, type JSX } from 'solid-js';
import { artistDestination, albumDestination, navigateMusic, performerNames, type MusicMetadata } from '../lib/musicNavigation';
import { createResponsiveTap } from '../lib/responsiveTap';
import styles from './MusicLinks.module.css';

/** Real hash links preserve copy/open-in-tab, while ordinary taps use the router. */
export function MusicLink(props: { path: string; class?: string; label?: string; onMenu?: (event?: MouseEvent) => void; children?: JSX.Element }) {
  const tap = createResponsiveTap({ onTap: (event) => {
    event.stopPropagation();
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigateMusic(props.path);
  }, onLongPress: props.onMenu ? () => props.onMenu?.() : undefined });
  return <a href={`#${props.path}`} class={`${styles.link} ${props.class ?? ''}`} draggable={false} aria-label={props.label}
    {...tap} onKeyDown={(event) => event.stopPropagation()}
    onContextMenu={(event) => { event.stopPropagation(); if (props.onMenu) { event.preventDefault(); props.onMenu(event); } }} onAuxClick={(event) => event.stopPropagation()}
    onDragStart={(event) => event.stopPropagation()}>{props.children}</a>;
}

export function ArtistLinks(props: { music: MusicMetadata; class?: string; fallback?: JSX.Element }) {
  return <span class={props.class}><Show when={props.music.linkable !== false && performerNames(props.music).length}
    fallback={props.fallback ?? props.music.artist}>
    <For each={performerNames(props.music)}>{(name, index) => <>
      {index() > 0 ? ', ' : ''}<MusicLink path={artistDestination(props.music, name)}>{name}</MusicLink>
    </>}</For>
  </Show></span>;
}

export function AlbumLink(props: { music: MusicMetadata; class?: string; onMenu?: (event?: MouseEvent) => void; children?: JSX.Element }) {
  return <Show when={props.music.linkable !== false && props.music.album?.trim()}
    fallback={<span class={props.class}>{props.children ?? props.music.album}</span>}>
    <MusicLink path={albumDestination(props.music)} class={props.class} onMenu={props.onMenu}>{props.children ?? props.music.album}</MusicLink>
  </Show>;
}
