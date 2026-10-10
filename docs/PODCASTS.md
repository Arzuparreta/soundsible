# Podcast discovery by country

The account's `podcast_country` discovery setting selects an Apple storefront.
Existing accounts default to `us`, preserving their previous market. The country
is independent of interface language, music discovery, autoplay and DJ selection.
It does not filter subscriptions, saved episodes, or shows by country of origin.

The setting is available in Settings → Playback and in the Podcasts globe
selector. On mobile the selector sits in the Podcasts app bar; on desktop it sits
to the right of the search field. A selection becomes active after the engine
confirms it. Searches and both charts refresh when it changes. Old chart results
are discarded when the selected country or signed-in account changes.

Android's native podcast directory and playback settings expose the same country
selection, show/episode charts and category filter. Country state is isolated by
native connection generation. Episode resolution hands the exact episode to the
existing native playback controller, retaining RSS provenance and reusing acquired
episodes; discovery imports no web audio stores. Existing native personalized
show recommendations remain available alongside the country charts.

## Apple sources

- Search: <https://performance-partners.apple.com/search-api>, with `country`.
- Storefronts: <https://rss.marketingtools.apple.com/apple/podcasts/storefronts>.
  The supported code list is a checked-in snapshot of the RSS builder, checked
  on 2026-10-10. Country names are localized with `Intl.DisplayNames`.
- Shows: `https://rss.marketingtools.apple.com/api/v2/{country}/podcasts/top/{limit}/podcasts.json`.
- Episodes: `https://rss.marketingtools.apple.com/api/v2/{country}/podcasts/top/{limit}/podcast-episodes.json`.

Both charts were exercised against Spain's public feeds. Their ranking order is
preserved, including followed shows. Show feed URLs are resolved through a
batched iTunes lookup in the same storefront. Chart data is bounded and cached
for 90 seconds by country and limit.

A popular episode is resolved on demand through its parent show's iTunes lookup,
matching both the episode and show identifiers. Audio playback then uses the
existing podcast token/stream path and reuses an already downloaded episode when
available. Looking at a chart or playing an episode never subscribes to its show.
An episode absent from Apple's returned recent episodes, or available only as
video, is reported as unavailable; another chapter is never substituted.

The retired `rss.itunes.apple.com` chart endpoint returned 503 during the initial
investigation. The popular charts use the current Marketing Tools feeds and show
an independent error/retry state if Apple fails. They never substitute generic
search results for rankings. The separate podcast recommendations API retains
its existing personalized logic and search fallback, with its exploration market
now taken from the saved country. Public editorial collections and Apple's
personalized recommendations have no confirmed public API in this integration.

The category picker filters the loaded show and episode rankings using Apple's
returned genre identifiers. It preserves their relative order and leaves followed
shows visible. It is a filter of the displayed results, not a separate full chart
for that genre. Changing country clears the category selection.
