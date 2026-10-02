import { Show } from 'solid-js';
import { ArtistLinks, MusicLink } from './MusicLinks';
import styles from './MusicListRow.module.css';
import { MusicListRowView, type MusicListRowViewProps } from './MusicListRowView';
import { isDownloadingKeys, isFavouriteKeys, state } from '../stores';
export type MusicListRowProps = MusicListRowViewProps;
/** Browser account adapter; the visual row is shared with the native catalogue. */
export function MusicListRow(props: MusicListRowProps) {
  return <MusicListRowView {...props}
    titleLink={label => <MusicLink path={props.titlePath!} class={styles.titleButton} label={label}
      onMenu={props.onMenu}><span class={styles.title}>{props.title}</span></MusicLink>}
    subtitleContent={<Show when={props.music} fallback={props.subtitle}>{(music) => <ArtistLinks music={music()} fallback={props.subtitle} />}</Show>} playbackTrack={state.playback.currentTrack}
    downloading={Boolean(props.entry && isDownloadingKeys(props.entry.keys))}
    favourite={props.favourite ?? Boolean(props.entry && isFavouriteKeys(props.entry.keys))} />;
}
