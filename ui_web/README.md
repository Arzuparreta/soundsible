# Soundsible web UI

This branch contains one player frontend: the SolidJS + TypeScript application in
`src/`. It is responsive and is used by browsers, mobile/PWA clients, and the
desktop shell. The legacy vanilla HTML/CSS/JS player deliberately does not exist
on this branch.

## Development

Start the Python engine on port 5005, then run:

```bash
npm install
npm run dev
```

Vite serves the UI on `http://localhost:5173/player/` and proxies `/api` and
`/socket.io` to `http://127.0.0.1:5005`.

## Verification

```bash
npm test
npm run build
```

`npm test` currently runs the TypeScript check. `npm run build` typechecks and
creates the production bundle in `dist/`.

## Running through the engine

Build first, then start Soundsible normally. The API automatically serves
`ui_web/dist/index.html` at both `/player/` and `/player/desktop/`. The desktop
route renders the same responsive application and injects its owner token for
protected engine calls.

Set `SOUNDSIBLE_WEB_UI_DIST=1` to require the built UI explicitly. Source
`index.html` is a Vite entry point and is not intended to run directly through
Flask without a build.
