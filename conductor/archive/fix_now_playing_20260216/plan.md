# Implementation Plan: WebUI Now Playing & Transport Controls

## Phase 1: Core Functionality Fixes
- [x] Task: Restore global `audioEngine` and `store` availability to ensure UI event handlers can reach core logic.
- [x] Task: Refactor `showNowPlaying` and `hideNowPlaying` to use CSS class-based orchestration (`active` class) instead of direct `style` manipulation.
- [x] Task: Attach surgical click listener to `#player-info` in `index.html` to reliably trigger the view.
- [x] Task: Conductor - User Manual Verification 'Core Functionality Fixes' (Protocol in workflow.md)

## Phase 2: Transport Control Synchronization
- [x] Task: Implement `updateTransportControls` logic to surgically sync icons across all player instances.
- [x] Task: Link Shuffle and Repeat buttons in Now Playing to `store` methods.
- [x] Task: Ensure mini-player controls use the same shared logic as full view.
- [x] Task: Conductor - User Manual Verification 'Transport Control Synchronization' (Protocol in workflow.md)

## Phase 3: Animation & Gesture Polish
- [x] Task: Refine "Slime" entrance transition in CSS with `visibility` and `pointer-events` safety.
- [x] Task: Verify drag-to-close gesture does not trigger long-press menu on dismissal.
- [x] Task: Implement Air-Gap cooldown (100ms) to swallow ghost clicks after view transitions.
- [x] Task: Conductor - User Manual Verification 'Animation & Gesture Polish' (Protocol in workflow.md)
