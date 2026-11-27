# Playable release demo

## Contract

A stable tag supplies the same Solid player that ships with Soundsible. A static directory must work under a GitHub Pages project prefix. Visitors enter Songs, choose music, seek and advance the queue on their own device. Audio starts on interaction. A scoped service worker supplies a local catalog and maps media requests to static files. The site should defer mounting the iframe until requested and offer a full-page link on mobile. Each recording needs reproducible provenance. Ship credits alongside the player.

## Release and acceptance

The landing build should resolve one stable tag for docs and demo, build or import the demo for that tag, and publish both together. The existing refresh_site release job dispatches deploy.yml when its token is configured, with the site's hourly workflow as fallback. Before deployment exercise Chromium and WebKit under a nested prefix, confirm the actual media clock advances, seek and wait for automatic advancement. Measure transferred bytes before interaction and during playback. Keep the previous deployment on failure.

## Iteration log

The screenshot engine uses Playwright interception, generated silence and a frozen media clock. Its data shape is reusable, its transport and recording are unsuitable for a public player. The production player requests media at origin-root API paths, so a scoped worker must control the player before navigation. Native byte range handling should be preserved.

## Current branch and reproduction

Run `npm ci --prefix ui_web`, then `scripts/pages_demo/build.sh /tmp/demo-preview/player` with an existing parent and an unused output path. Serve the parent with a static HTTP server. Run `node scripts/pages_demo/smoke.mjs http://localhost:8000/player/` and repeat with the final argument `webkit`. On Linux use the repository's matching Playwright container for WebKit. To preview both branches together, build directly into the site's empty public/demo directory and run its normal Astro build and browser tests.

The static prototype renders two original CC0 recordings from scores. Each WAV is 705,644 bytes. Chromium and phone-sized WebKit both advanced the media clock, sought near the end of Glass Steps and automatically started Late Platform. The first seek experiment restarted the song because the simple static server ignored Range. The worker now returns partial content when the host returns a complete file. The landing branch loads the frame on click and retains the gallery for releases predating the builder.

This is a local listening demo. Remote devices, discovery, downloads and persistent favourites still require engine contracts. Their navigation is visible. A future pass should decide which controls to expose for this catalog, expand the music selection, and measure cold loads on physical devices. Public release-to-Pages deployment remains unverified pending review and a stable release.
