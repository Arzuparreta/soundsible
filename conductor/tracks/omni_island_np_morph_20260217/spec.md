# Specification: Omni-Island NP-Morph

## Overview
This specification details the implementation of a new **NP-Morph** state for the Omni-Island, enabling it to transform into a large, glassmorphic playback dock when the full-screen Now Playing view is active.

## 1. Visual Design: The NP-Morph State

### 1.1 Dimensions & Shape
- **Expanded Size:** Width `320px`, Height `240px` (or similar rectangular proportions).
- **Corner Radius:** `40px` to maintain the "Cyber-Premium" look.
- **Glassmorphism:** Consistent `60px` backdrop blur and `background: rgba(255, 255, 255, 0.05)`.

### 1.2 Layout Expansion
- **Control Layout:** The `[Prev] [Play/Pause] [Next]` controls will spread out vertically and horizontally within the expanded rectangle.
- **Progress Integration:** The under-bar progress indicator will transition to a more prominent position or style within the dock.
- **Metadata:** Song title and artist will remain visible, potentially moving to a dedicated section within the rectangle.

## 2. Interaction & Animation

### 2.1 "Premium Slime" Morph
- **Trigger:** Transition to NP-Morph state upon `UI.showNowPlaying()`.
- **Reverse Trigger:** Collapse back to the appropriate stable state (`Active` or `Seed`) upon `UI.hideNowPlaying()`.
- **Physics:** `cubic-bezier(0.19, 1, 0.22, 1)` curve over `0.6s`.

### 2.2 Gesture Sync
- **Swipe-Up Integration:** The swipe-up gesture on the island will directly trigger the morph and the Now Playing view opening.
- **Dismissal Sync:** The swipe-down to dismiss the Now Playing view will trigger the reverse morph.

## 3. Technical Requirements
- **Z-Index Management:** Ensure the Omni-Island stays above the Now Playing view layer (`z-index: 200+`).
- **Control Sync:** Real-time synchronization of transport controls between the dock and the backend.
