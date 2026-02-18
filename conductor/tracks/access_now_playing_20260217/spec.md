# Specification: Swipe-Up for Now Playing

## Overview
This specification details the implementation of a swipe-up gesture on the **Omni-Island** to trigger the full-screen **Now Playing** view.

## 1. Interaction & Gesture Engine

### 1.1 Detection
- **Touch Layer:** Utilize the `omni-touch-area` for gesture detection.
- **Direction:** Detect a vertical swipe starting from within the island's boundary and moving upwards.
- **Threshold:** Trigger the transition when the vertical displacement (`deltaY`) exceeds `-60px` (upwards).

### 1.2 Behavior
- **Trigger:** Upon reaching the threshold, call `UI.showNowPlaying()`.
- **Haptic Integration:** Trigger a 30ms "heavy" pulse (`Haptics.heavy()`) when the gesture is successful.
- **Visual Feedback:** Provide subtle vertical displacement of the island during the swipe to indicate movement.

## 2. Animation & Transitions

### 2.1 Entrance Animation
- **Curve:** Standardize on the `cubic-bezier(0.19, 1, 0.22, 1)` (Premium Slime) curve.
- **Duration:** `0.6s` for the full-screen transition.
- **State:** Ensure the Omni-Island resets to its stable state after the transition starts.

## 3. Technical Requirements
- **Interruption Recovery:** Ensure the gesture doesn't conflict with existing tap or hold (Bloom) logic.
- **Platform Safety:** Verify the gesture doesn't trigger system-level "Home" or "App Switcher" actions on iOS/Android.
