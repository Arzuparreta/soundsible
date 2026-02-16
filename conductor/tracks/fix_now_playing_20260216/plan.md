# Implementation Plan: WebUI Now Playing & Transport Controls (RESUMED)

> **Note:** This track was resumed after a failed deployment and subsequent regression caused by another agent's interference. We have re-implemented and verified all changes with robust input handling and premium glassmorphic design.

## Phase 1: Recovery & Core Fixes
- [x] Task: Audit current state of `index.html`, `js/app.js`, `js/ui.js`, and `css/style.css` to identify regressions. c6983ec
- [x] Task: Restore global `audioEngine` and `store` availability to ensure UI event handlers can reach core logic. c6983ec
- [x] Task: Refactor `showNowPlaying` and `hideNowPlaying` to use CSS class-based orchestration (`active` class) instead of direct `style` manipulation. c6983ec
- [x] Task: Attach surgical click listener to `#player-info` in `index.html` to reliably trigger the view. c6983ec
- [x] Task: Fix "no songs" issue - verify `audioEngine` and `store` initialization. c6983ec
- [x] Task: Fix "unresponsive UI" - check for `pointer-events: none` or blocked event listeners. c6983ec
- [x] Task: Conductor - User Manual Verification 'Recovery & Core Fixes' (Protocol in workflow.md)

## Phase 2: Transport Control Synchronization
- [x] Task: Implement `updateTransportControls` logic to surgically sync icons across all player instances. c6983ec
- [x] Task: Link Shuffle and Repeat buttons in Now Playing to `store` methods. c6983ec
- [x] Task: Ensure mini-player controls use the same shared logic as full view. c6983ec
- [x] Task: Conductor - User Manual Verification 'Transport Control Synchronization' (Protocol in workflow.md)

## Phase 3: Animation & Gesture Polish
- [x] Task: Refine "Slime" entrance transition in CSS with `visibility` and `pointer-events` safety. c6983ec
- [x] Task: Verify drag-to-close gesture does not trigger long-press menu on dismissal. c6983ec
- [x] Task: Implement Air-Gap cooldown (100ms) to swallow ghost clicks after view transitions. c6983ec
- [x] Task: Conductor - User Manual Verification 'Animation & Gesture Polish' (Protocol in workflow.md)
