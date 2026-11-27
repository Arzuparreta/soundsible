# Playable release demo

## Product contract

The landing page offers the shipping Soundsible web player with an open listening collection. The player opens on Albums, works under a GitHub Pages project path and plays full recordings after a user gesture. Visitors can browse albums, songs and artists, search the included tracks, seek, queue tracks and mark favourites. Favourites stay in the browser. The landing page shows the included recordings before activation, offers an embedded and a full-page player, and links to individual music credits. The embedded player unloads when closed.

The public demo runs from static files, including the catalog, artwork and full MP3s. Station-backed features such as DJ, radio, importing, device control and downloads are outside this demo's scope. Full studio album listings and lyrics are also outside the catalog. The landing page retains the existing gallery for older release tags that lack the demo builder.

## Release path

The landing Actions build resolves one published stable Soundsible SHA for its documentation and demo, then checks out that SHA. The original Vite build compiles the tagged player with a demo-only adapter. The release source moves out of the landing workspace before the site's own tests discover files. If the release supplies a builder, packaging or browser test failures prevent Pages from publishing the new output. The Soundsible release workflow can request the site rebuild with its existing dispatch token, and the site's hourly build also resolves the published stable release.

The builder authenticates into a browser-local catalog, swaps the request transport and media URL helpers, and skips station sockets and service-worker registration. The release player retains local playback and its normal collection, queue and transport controls. The demo Vite plugin owns the presentation substitutions. Keep all demo overrides here so installed Soundsible surfaces keep using the regular modules.

## Test and handoff

- Soundsible review branch and player build: [PR #533](https://github.com/Arzuparreta/soundsible/pull/533).
- Landing page activation and release ingestion: [PR #20](https://github.com/Arzuparreta/soundsible.github.io/pull/20).
- After `npm ci --prefix ui_web`, run `scripts/pages_demo/build.sh /tmp/example-demo` with an unused output directory. Serve the directory over HTTP with byte ranges, such as `vite preview` with the demo output as `--outDir` and a nested `--base`. See the Pages demo workflow for its exact commands.
- To review both branches together, build the Soundsible branch into an empty `public/demo` under the landing checkout and run the site's `npm run dev`. The site links to `demo/index.html` because Astro's development server serves public files by filename. Restart that server after replacing the generated directory so its public-file index sees the rebuilt assets.
- Run `node scripts/pages_demo/smoke.mjs <demo-url>` in Chromium and repeat with the additional argument `webkit`. Use `--embedded` with the landing URL to check the iframe. On Linux use the repository's Playwright image for WebKit when host libraries are missing. The landing repo also tests both locales, deferred loading, audio playback and closing the frame. Browser CI checks the direct static build on source changes and tagged releases.

## Iterations and evidence

1. The showcase fixture uses Playwright interception, generated silence and a frozen media clock. A prototype served its own synthetic audio through a service worker. This proved that the real player could play static files, seek and advance, but the service worker prevented startup on a forwarded plain HTTP origin.
2. The worker-free prototype used the existing request transport hook and direct media URLs. Chromium played inside a forwarded-style insecure HTTP origin with service workers unavailable. The build keeps this architecture.
3. The review version includes five full recordings by Josh Woodward and Chris Zabriskie with pinned MP3 bytes and track-level Creative Commons credits. The two sleeves were illustrated for the demo. The files encode the complete source recordings at 96 kbps. They add approximately 16 MB to the Pages artifact, fetched one track at a time during playback. The landing carousel is replaced by the live player and its album launch card on supported releases.
4. Desktop Chromium and phone-sized WebKit passed the album → playback → seek → next track → persisted favourite flow. Chromium additionally passed local search and explicit Play next. The landing output passed its unit, build and browser checks with the demo present. In a local cold Chromium run the iframe made zero requests before activation. It displayed albums after 248 ms, with 946,273 bytes transferred during startup before playing. Browsing loaded no MP3 and the flow made no engine API or socket requests. This is a loopback measurement, without CDN compression or a physical iPhone.
5. The two review branches can be tested together on the local development server. The public GitHub Pages refresh with this version still requires a stable release containing the final builder and publication of the landing integration.
