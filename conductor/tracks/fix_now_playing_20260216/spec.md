# Specification: WebUI Now Playing & Transport Controls

## Overview
Fix the currently broken "Now Playing" view in the WebUI player. Ensure that clicking/tapping the mini-player correctly opens the full-screen view and that all transport controls (Play/Pause, Prev, Next, Shuffle, Repeat) are fully functional and synchronized across all UI components.

## Functional Requirements
- Mini-player info area must trigger the `showNowPlaying` view on click/tap.
- Now Playing view must use `visibility` and `opacity` for stable transitions.
- Play/Pause, Skip, Previous buttons in Now Playing must be functional.
- Shuffle and Repeat buttons must be functional and show active states.
- All controls must remain synchronized between the mini-player and the full view.
- Drag-to-dismiss gesture for Now Playing must be robust and not conflict with internal controls.

## Non-Functional Requirements
- High-end "Slime" spring physics for all transitions.
- Zero-latency interaction feel.
- Correct layering (z-index) to prevent touch leaks to background elements.

## Acceptance Criteria
- Clicking song info opens Now Playing with a smooth slide-up animation.
- Tapping pause in Now Playing instantly updates the mini-player icon.
- Shuffle/Repeat toggles work and update icons in both views.
- No "ghost clicks" or accidental triggers during view transitions.
