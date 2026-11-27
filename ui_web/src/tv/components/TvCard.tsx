import { Control } from '../../design/Control';
import { useTvFocus } from '../nav/spatial';
import styles from '../styles/tv.module.css';
import { TvArtwork } from './TvArtwork';

export function TvCard(props: {
  id: string;
  group: string;
  index: number;
  title: string;
  subtitle: string;
  artwork?: string;
  onActivate: () => void;
}) {
  const focus = useTvFocus();
  return (
    <Control
      data-tv-id={props.id}
      data-tv-group={props.group}
      data-tv-index={String(props.index)}
      data-tv-focused={focus.activeId() === props.id ? 'true' : undefined}
      class={styles.tvCard}
      classList={{ [styles.tvFocusTarget]: true }}
      onClick={props.onActivate}
    >
      <TvArtwork class={styles.tvCardArt} src={props.artwork} alt="" fallbackLabel={props.title} />
      <span class={styles.tvCardTitle}>{props.title}</span>
      <span class={styles.tvCardMeta}>{props.subtitle}</span>
    </Control>
  );
}
