import { createMemo, createSignal, For, Show, onMount, onCleanup } from 'solid-js';
import { A } from '@solidjs/router';
import { api } from '../lib/api';
import { state, actions } from '../stores';
import { ensureDiscover, topPodcasts } from '../lib/discover';
import { t } from '../lib/i18n';
import type { PodcastSearchResult } from '../types/podcast';
import styles from './Podcasts.module.css';
import { neutralCoverStyle } from '../lib/cover';
import { attachContextMenu } from '../lib/contextMenu';
import type { ActionMenuOptions } from '../components/ActionMenu';
import { toast } from '../lib/toast';

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/** Podcasts: your subscriptions grid + iTunes directory search → subscribe. */
export default function Podcasts() {
  const [q, setQ] = createSignal('');
  const [results, setResults] = createSignal<PodcastSearchResult[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [subscribing, setSubscribing] = createSignal<Set<string>>(new Set());

  const subscribedFeeds = createMemo(() => new Set(state.podcastSubscriptions.map((s) => s.rss_url)));
  const recommendedPodcasts = createMemo(() =>
    topPodcasts().filter((podcast) => !subscribedFeeds().has(podcast.feed_url)),
  );

  let aborter: AbortController | undefined;
  let debounce: number | undefined;

  onMount(() => ensureDiscover());

  const run = (query: string) => {
    query = query.trim();
    if (query.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    aborter?.abort();
    aborter = new AbortController();
    setLoading(true);
    api
      .searchPodcasts(query, aborter.signal)
      .then(setResults)
      .catch((e) => {
        if (!isAbort(e)) setResults([]);
      })
      .finally(() => setLoading(false));
  };

  const onInput = (v: string) => {
    setQ(v);
    clearTimeout(debounce);
    debounce = window.setTimeout(() => run(v), 300);
  };

  const subscribe = async (r: PodcastSearchResult) => {
    setSubscribing((s) => new Set(s).add(r.feed_url));
    try {
      await api.subscribePodcast({
        rss_url: r.feed_url,
        title: r.title,
        author: r.author,
        image_url: r.image_url,
        itunes_collection_id: r.itunes_collection_id,
      });
      void api.emitDiscoveryEvent('podcast_subscribed', {
        media_type: 'podcast_show',
        podcast_feed_id: r.feed_url,
        podcast_show_title: r.title,
        podcast_author: r.author,
        itunes_collection_id: r.itunes_collection_id,
        source: 'podcast_directory',
      }).catch(() => {});
      await actions.syncLibrary();
    } catch {
      // ignore
    } finally {
      setSubscribing((s) => {
        const n = new Set(s);
        n.delete(r.feed_url);
        return n;
      });
    }
  };

  const recommendationMenu = (p: PodcastSearchResult): ActionMenuOptions | null => {
    if (!p.recommendation_identity) return null;
    return {
      title: p.title,
      subtitle: p.author,
      actions: [
        ...(p.reason ? [{ label: p.reason, disabled: true, onSelect: () => {} }] : []),
        {
          label: t('trackActions.notInterested'),
          onSelect: () => {
            void api.sendDiscoveryFeedback({
              media_type: 'podcast_show',
              podcast_feed_id: p.feed_url,
              podcast_show_title: p.title,
              podcast_author: p.author,
              itunes_collection_id: p.itunes_collection_id,
              source: 'podcast',
            }).then((result) => {
              if (!result.recorded || !result.event_id) return;
              toast.action(t('trackActions.feedbackSaved'), t('common.undo'), () => {
                void api.undoDiscoveryFeedback(result.event_id!).catch(() => {});
              });
            }).catch(() => toast.error(t('trackActions.feedbackFailed')));
          },
        },
      ],
    };
  };

  onCleanup(() => {
    aborter?.abort();
    clearTimeout(debounce);
  });

  return (
    <div class="view">
      <div class={styles.bar}>
        <input
          class={styles.input}
          type="search"
          placeholder={t('podcasts.searchPlaceholder')}
          value={q()}
          onInput={(e) => onInput(e.currentTarget.value)}
        />
      </div>

      <div class={styles.scroll}>
        <Show
          when={q().trim().length >= 2}
          fallback={
            <>
              <Show when={state.podcastSubscriptions.length > 0}>
                <h2 class={styles.sectionTitle}>{t('podcasts.yourShows')}</h2>
                <div class={styles.grid}>
                  <For each={state.podcastSubscriptions}>
                    {(s) => (
                      <A href={`/podcasts/${encodeURIComponent(s.id)}`} class={styles.card}>
                        <div class={styles.cover} style={neutralCoverStyle(s.image_url)} />
                        <span class={styles.name}>{s.title}</span>
                        <span class={styles.author}>{s.author}</span>
                      </A>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={recommendedPodcasts().length > 0}>
                <h2 class={styles.sectionTitle}>{t('podcasts.top')}</h2>
                <div class={styles.grid}>
                  <For each={recommendedPodcasts()}>
                    {(p) => (
                      <button
                        class={styles.cardBtn}
                        ref={(el) => attachContextMenu(el, () => recommendationMenu(p))}
                        type="button"
                        disabled={subscribedFeeds().has(p.feed_url) || subscribing().has(p.feed_url)}
                        onClick={() => subscribe(p)}
                      >
                        <div class={styles.cover} style={neutralCoverStyle(p.image_url)} />
                        <span class={styles.name}>{p.title}</span>
                        <span class={styles.author}>
                          {subscribedFeeds().has(p.feed_url) ? t('podcasts.subscribed') : p.author}
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={state.podcastSubscriptions.length === 0 && recommendedPodcasts().length === 0}>
                <p class={styles.hint}>{t('podcasts.hint')}</p>
              </Show>
            </>
          }
        >
          <Show when={loading() && results().length === 0}>
            <For each={Array.from({ length: 6 })}>{() => <div class={styles.skeleton} />}</For>
          </Show>
          <Show when={!loading() && results().length === 0}>
            <p class={styles.hint}>{t('podcasts.noResults')}</p>
          </Show>
          <For each={results()}>
            {(r) => (
              <div class={styles.row}>
                <div class={styles.rowCover} style={neutralCoverStyle(r.image_url)} />
                <div class={styles.meta}>
                  <span class={styles.title}>{r.title}</span>
                  <span class={styles.sub}>{r.author}</span>
                </div>
                <Show
                  when={!subscribedFeeds().has(r.feed_url)}
                  fallback={<span class={styles.subbed}>{t('podcasts.subscribed')}</span>}
                >
                  <button
                    class={styles.subBtn}
                    type="button"
                    disabled={subscribing().has(r.feed_url)}
                    onClick={() => subscribe(r)}
                  >
                    {subscribing().has(r.feed_url) ? t('podcasts.subscribing') : t('podcasts.subscribe')}
                  </button>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}
