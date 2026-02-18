# Implementation Plan: Swipe-Up for Now Playing

## Phase 1: Gesture Detection & Trigger (Completed)
- [x] Modify `initOmniGestures` to track vertical displacement (`deltaY`).
- [x] Implement detection logic for swipe-up above the `-60px` threshold.
- [x] Connect the successful swipe to `UI.showNowPlaying()`.
- [x] Integrate `Haptics.heavy()` tactile feedback on successful trigger.

## Phase 2: Visual Feedback & Animation (Completed)
- [x] Add subtle vertical displacement to the island during the swipe gesture.
- [x] Ensure the island resets correctly if the swipe is canceled or completed.
- [x] Verify the "Premium Slime" transition feels cohesive with the gesture.

## Phase 3: Verification & Polishing (Completed)
- [x] Audit for conflicts with existing tap and hold gestures.
- [x] Test on mobile (iOS/Android) for system-level gesture interference.
- [x] Verify 60fps performance for the combined gesture and transition.
- [x] Implemented mirrored Swipe-Down gesture to close full-screen view.
- [x] Added 120ms delay to label shrink animation to protect single-tap logic.
- [x] Reduced swipe-visual feedback travel by 18% for better control.
