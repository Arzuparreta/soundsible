# Implementation Plan: Omni-Island NP-Morph

## Phase 1: Structural Morph (Completed)
- [x] Define the `NP-Morph` state dimensions and CSS transitions in `index.html`.
- [x] Modify `UI.showNowPlaying()` to trigger the island expansion.
- [x] Modify `UI.hideNowPlaying()` to trigger the island collapse.

## Phase 2: Internal Layout Expansion (Completed)
- [x] Implement conditional layout for transport controls in NP-Morph state.
- [x] Refine icon sizing and spacing within the expanded rectangle.
- [x] Transition metadata and progress indicators to their new positions.

## Phase 3: Synchronization & Polishing (Completed)
- [x] Ensure perfect state sync between the morph and the Now Playing view layer.
- [x] Audit animations for 60fps performance and "Premium Slime" consistency.
- [x] Verify notch-safety and tactile feedback for all expanded controls.
