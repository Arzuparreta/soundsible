import { createEffect, on } from 'solid-js';
import Button from '../components/Button';
import NewReleasesRail from '../components/NewReleasesRail';
import styles from '../components/HomeNewReleases.module.css';
import { createNewReleases, releaseDestination } from '../lib/newReleases';

/** Native Android Home New Releases rail backed by the user's Taste Profile. */
export default function NativeNewReleases(props: {
  generation: () => number;
  disconnected: () => boolean;
  onOpenEntityPath: (path: string) => void;
}) {
  const { items, load, reset, subscribe } = createNewReleases(props.generation, props.disconnected);

  createEffect(on(() => [props.generation(), props.disconnected()] as const, ([generation, disconnected], previous) => {
    if (!previous || generation !== previous[0]) reset();
    if (!disconnected) void load();
  }));

  subscribe();

  return <NewReleasesRail items={props.disconnected() ? [] : items()} renderCard={(item, content) => (
    <Button variant="ghost" size="sm" class={styles.nativeCard} aria-label={item.title}
      onClick={() => props.onOpenEntityPath(releaseDestination(item))}>{content}</Button>
  )} />;
}
