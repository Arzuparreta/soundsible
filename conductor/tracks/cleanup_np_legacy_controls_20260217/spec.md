# Specification: Cleanup Legacy Now Playing Controls

## Overview
This specification details the removal of legacy playback controls from the full-screen **Now Playing** view, which are now redundant following the implementation of the **Omni-Island NP-Morph** dock.

## 1. UI Components for Removal

### 1.1 `index.html`
- Remove the entire container containing `np-shuffle-btn`, `np-prev-btn`, `np-play-btn`, `np-next-btn`, and `np-repeat-btn`.
- Remove the legacy time indicators (`np-time-curr`, `np-time-total`).
- Remove the legacy progress bar container (`np-seek-container`).

## 2. Logic Cleanup

### 2.1 `ui.js`
- Remove all transport button click handlers for the deleted IDs in `initGlobalListeners`.
- Remove time and progress update logic for the deleted IDs in the `audio:timeupdate` listener.
- Update `updateNowPlaying` and `updateTransportControls` to stop attempting to sync with the deleted elements.

## 3. Technical Requirements
- **Regression Testing:** Ensure the Omni-Island NP-Morph dock remains fully functional and correctly synced after the cleanup.
- **Styling Audit:** Adjust the layout of the Now Playing view to account for the removed elements, ensuring a clean and technical aesthetic.
