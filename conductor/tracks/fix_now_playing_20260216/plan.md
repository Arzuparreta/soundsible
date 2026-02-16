# Implementation Plan: Unified Omni-Island Control System

Implement a state-driven, bottom-center control capsule that unifies navigation and playback transport with high-end tactile interaction.

## Phase 1: Structural Foundation & Adaptive Sizing
- **Objective**: Create the core Omni-Island component with state-driven widths.
- **Adaptive States**:
    - **Seed (56px)**: Idle/Closed state.
    - **Active (286px)**: Playback mode with [Prev][Anchor][Next] controls.
    - **Bloom (380px)**: Navigation mode with 7-position grid.
- **Tasks**:
    - [x] Implement glassmorphic capsule with `backdrop-filter`.
    - [x] Develop `morphToActive()` and `collapseToSeed()` transitions.
    - [x] Standardize 16px (`px-4`) technical margin across all states.

## Phase 2: Surgical Interaction Engine
- **Objective**: Establish reliable, intentional touch logic for mobile.
- **Interaction Models**:
    - **Safe Release**: Actions trigger on `touchend` only if release is within the zone.
    - **Coordinate-Based Detection**: Divide the island into technical thirds (Left/Center/Right) using X-coordinate math.
    - **Hold-to-Bloom**: 400ms hold on center anchor triggers the navigation ribbon.
- **Tasks**:
    - [x] Implement coordinate-based zone detection.
    - [x] Add `omni-touch-area` with 20px invisible safety margin.
    - [x] Develop drag-to-cancel logic for transport taps.

## Phase 3: Symmetrical Bloom Navigation
- **Objective**: Create an intuitive, thumb-friendly navigation grid.
- **Layout**:
    - Uniform 7-slot grid with blank center spacer.
    - Order: `Home` | `Liked` | `Albums` | `[Blank]` | `Search` | `Downloader` | `Settings`.
- **Tasks**:
    - [x] Implement `justify-between` flex model for the ribbon.
    - [x] Add real-time haptic tracking for menu selection.
    - [x] Ensure 400ms "Fast Bloom" timing feels responsive.

## Phase 4: Professional Visual Feedback
- **Objective**: Add tactile confirmation without visual clutter.
- **Technique**:
    - **Subtle Inflation**: 300ms "breath" animation (`scale 1.08`) on tap release.
- **Tasks**:
    - [x] Implement `omni-tap-inflate` keyframes.
    - [x] Bind animation triggers to release-event zones.
    - [x] Standardize 15ms haptic pulses for all taps.
