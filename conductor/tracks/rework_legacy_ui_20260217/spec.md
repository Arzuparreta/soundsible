# Specification: UI Rework for Project Components

## Overview
This specification details the rework of legacy UI components within the Soundsible Station (WebUI) to align with the new **Omni-Island** navigation system and the "Cyber-Premium" design language.

## 1. Now Playing View (Full-Screen) - COMPLETED
...

## 2. Song Rows/Lists - COMPLETED
...

## 3. Album Grid

### 3.1 Visual Refinements
- **Card Design:** Update album cards with a more technical, glossy finish and a larger corner radius (`32px`).
- **Typography:** Use **Plus Jakarta Sans** for album titles and **JetBrains Mono** for artist names.
- **Shadows:** Implement deeper, large-radius shadows for a floating effect.

### 3.2 Interaction & Animation
- **Hover/Active Scale:** Refine the 500ms scale animation to use the `cubic-bezier(0.19, 1, 0.22, 1)` curve.
- **Haptic Integration:** Add a subtle 15ms pulse (`Haptics.tick()`) when an album is selected.

## 4. Action Menu (Bottom Sheet) & Modals

### 4.1 Visual Refinements
- **Glassmorphism:** Apply consistent `60px` backdrop blur and `var(--glass-border)` to all sheets and modals.
- **Typography:** Standardize on the primary/technical typography hierarchy.
- **Layout:** Ensure all modals are "notch-safe" and use the **Metadata Surgeon** surgical mode indicators.

### 4.2 Interaction & Animation
- **"Premium Slime" Motion:** Standardize sheet entrance and dismissal animations to 0.6s with the Premium Slime curve.
- **Swipe Dismissal:** Implement the 14% height threshold for the Action Menu sheet.
- **Haptics:** Add tactile confirmation for all menu actions (15ms pulse) and sheet triggers.

## 5. Technical Requirements
- **Performance:** Ensure all animations maintain 60fps.
- **Accessibility:** Maintain high contrast ratios and visible focus indicators.
- **Responsiveness:** Use `env(safe-area-inset-*)` for consistent layout on all devices.
