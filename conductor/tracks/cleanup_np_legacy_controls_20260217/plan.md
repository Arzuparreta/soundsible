# Implementation Plan: Cleanup Legacy Now Playing Controls

## Phase 1: UI Removal (Completed)
- [x] Remove legacy transport buttons and time indicators from `index.html`.
- [x] Remove redundant progress bar container from `index.html`.
- [x] Adjust Now Playing layout for a cleaner, focused aesthetic.

## Phase 2: Logic Cleanup (Completed)
- [x] Update `initGlobalListeners` in `ui.js` to remove redundant handlers.
- [x] Clean up the `audio:timeupdate` listener in `ui.js`.
- [x] Refactor `updateNowPlaying` and `updateTransportControls` in `ui.js`.

## Phase 3: Verification & Polishing (Completed)
- [x] Perform a full UI audit for layout consistency.
- [x] Verify Omni-Island NP-Morph functionality and synchronization.
- [x] Ensure 60fps performance and no console errors.
