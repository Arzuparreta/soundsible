import { createStageBackdrops } from '../lib/stageBackdrop';
import { ArtworkBackdrop } from './ArtworkBackdrop';
import styles from './StageBackdrop.module.css';

export function StageBackdrop(props: {
  visible: boolean;
  drift?: boolean;
  hideLayers?: boolean;
  auto?: boolean;
  autoWide?: boolean;
  playerMarks?: boolean;
}) {
  const backdrops = createStageBackdrops();

  return (
    <>
      <ArtworkBackdrop
        class={styles.backdrop}
        activeClass={styles.backdropActive}
        driftClass={props.drift ? styles.backdropDrift : undefined}
        hiddenClass={styles.backdropHidden}
        hidden={props.hideLayers}
        playerMark={props.playerMarks}
        src={backdrops().first}
        active={backdrops().active === 'first'}
        visible={props.visible}
      />
      <ArtworkBackdrop
        class={styles.backdrop}
        activeClass={styles.backdropActive}
        driftClass={props.drift ? styles.backdropDrift : undefined}
        hiddenClass={styles.backdropHidden}
        hidden={props.hideLayers}
        playerMark={props.playerMarks}
        src={backdrops().second}
        active={backdrops().active === 'second'}
        visible={props.visible}
      />
      <div
        class={styles.wash}
        classList={{
          [styles.washAuto]: Boolean(props.auto),
          [styles.washAutoWide]: Boolean(props.autoWide),
        }}
        data-player-veil={props.playerMarks ? '' : undefined}
        aria-hidden="true"
      />
      <div class={styles.grain} aria-hidden="true" />
    </>
  );
}
