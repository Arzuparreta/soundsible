# Specification: High-Performance Virtual Scrolling

## Overview
Implement a custom, high-performance **Virtual Scroller** for the song list to eliminate scrolling lag and visual artifacts (prematurely visible labels) in large libraries. This ensures that only the elements currently in the viewport are rendered in the DOM.

## 1. Core Engine: `VirtualList`

### 1.1 Detection & Math
- **Row Height:** Standardized at `72px` (including margin).
- **Viewport Tracking:** Use the `scroll` event on the `#view-*` containers to calculate the `startIndex` and `endIndex` of visible tracks based on `scrollTop`.
- **Buffer:** Maintain a buffer of 5-10 items above and below the viewport to prevent flickering during rapid scrolling.

### 1.2 Rendering Strategy
- **Absolute Positioning:** Use a container with a fixed height (`totalTracks * rowHeight`) to maintain the scrollbar's size.
- **Dynamic Placement:** Absolutely position only the visible song rows within this container using `transform: translateY()`.
- **Reusability:** Instead of full re-renders, update the `data-id` and content of existing DOM nodes if possible, or efficiently recycle them.

## 2. Visual Polish

### 2.1 Instant Load
- **Sync Integration:** The scroller must work seamlessly with the existing background `syncLibrary()` and reactive state store.
- **Loading State:** Ensure no "empty boxes" or "revealed labels" appear by ensuring the row background is fully rendered before the content.

### 2.2 Gesture Compatibility
- **Swipes:** Ensure that horizontal swipe gestures (Queue/Favourite) continue to work correctly on virtualized rows.
- **Interruption:** Standardize interaction physics to handle rapid scroll-to-stop transitions.

## 3. Technical Requirements
- **60fps:** All scroll-triggered DOM updates must complete within the 16ms frame budget.
- **Memory:** Drastically reduce the DOM node count for large libraries (e.g., from 1000+ nodes to ~20 nodes).
