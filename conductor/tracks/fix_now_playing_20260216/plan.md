# Implementation Plan: High-End Dual-Mode Theme (JetBrains & TypeScript)

Re-implement the high-end UI with dual-mode support, specific color palettes (JetBrains Orange / TypeScript Blue), and premium glassmorphic features as discussed in the planning phase.

## Phase 1: Theme Engine & Palette Initialization
**Objective**: Establish the CSS variable system for Light and Dark modes.

- **Dark Mode Palette**:
    - Background: `#0d0d0f` (Deep Charcoal)
    - Surface: `#1e1f22` (IDE Gray)
    - Selection: `#2e436e` (IDE Selection Blue)
    - Accent: `#f97a12` (JetBrains Orange)
    - Secondary: `#3178c6` (TypeScript Blue)
    - Text: `#dfe1e5` (Light Gray)
- **Light Mode Palette**:
    - Background: `#f5f5f5` (Paper White)
    - Surface: `#ffffff` (Pure White)
    - Selection: `#deeaff` (Soft Blue)
    - Accent: `#3178c6` (TypeScript Blue)
    - Secondary: `#f97a12` (JetBrains Orange)
    - Text: `#1c1c1c` (Dark Gray)

- **Tasks**:
    - [ ] Define `:root` CSS variables for both modes.
    - [ ] Implement `[data-theme="light"]` overrides.
    - [ ] Add theme persistence to `store.js` and a toggle in `Settings`.

## Phase 2: Premium UI Components (JetBrains Style)
**Objective**: Refactor all views to use the professional, IDE-inspired aesthetic.

- **Tasks**:
    - [ ] **Song Rows**: Use deep charcoal backgrounds, ultra-thin borders, and clean typography.
    - [ ] **Active Track**: Highlight with professional selection colors and an Orange pulsing icon.
    - [ ] **Album Grid**: Implement glossy, high-depth cards with smooth scale animations.
    - [ ] **Glassmorphism**: Apply consistent `backdrop-filter` and `glass-view` classes across all floating panels.

## Phase 3: High-End Interaction & Animations
**Objective**: Ensure the UI feels tactile and "Cyber-Premium."

- **Tasks**:
    - [ ] **"Slime" Entrance**: Refine the Now Playing spring physics (`cubic-bezier(0.19, 1, 0.22, 1)`).
    - [ ] **Haptics**: Add `vibrate()` pulses to all primary interactions (play, tab switch, swipe).
    - [ ] **Swipe Actions**: Ensure horizontal swipe gestures for Favourite/Queue are silky smooth.

## Phase 4: Final Polishing & Mobile Optimization
- [ ] Verify "Smart Next" logic within the new theme.
- [ ] Ensure perfect "safe-area" handling for iPhone and modern Android devices.
- [ ] Perform a full UI audit to remove any generic "blue" defaults.
