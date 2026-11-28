import { onMount } from 'solid-js';
import { createNewReleases, releaseDestination } from '../lib/newReleases';
import { userKey } from '../lib/session';
import NewReleasesRail from './NewReleasesRail';
import { MusicLink } from './MusicLinks';
import styles from './HomeNewReleases.module.css';

/** Taste-profile New Releases rail rendered lazily on the Library Home page. */
export default function HomeNewReleases() {
  const { items, load, subscribe } = createNewReleases(() => userKey('home-new-releases'));

  onMount(() => {
    void load();
    subscribe();
  });

  return <NewReleasesRail items={items()} renderCard={(item, content) => (
    <MusicLink class={styles.card} path={releaseDestination(item)} label={item.title}>{content}</MusicLink>
  )} />;
}
