# Specification: Performance Audit & Mini Player Implementation

## 1. Objectives
- Resolve performance lag in Omni-Island navigation gestures.
- Restore consistent technical nomenclature across the WebUI.
- Integrate orphaned GTK UI snippets into the main application.

## 2. Technical Scope

### WebUI Optimization
- **Gesture Lag**: Audit `touchmove` listeners in `ui.js`. Replace expensive DOM queries with optimized detection logic.
- **Label Docking**: Ensure labels follow "Cyber-Premium" design standards (JetBrains Mono, Orange docked state, bottom-aligned).

### GTK Mini Player
- **Main Window**: Restructure `MainWindow` to support a `Gtk.Stack` layout.
- **Mini View**: Implement a dedicated compact view for the player (`mini` named child in stack).
- **Synchronization**: Ensure all playback state (artwork, progress, metadata) is mirrored across views.
- **Navigation**: Add F12 shortcut and header button for mode toggling.

## 3. Success Criteria
- 60fps tracking for Omni-Island gestures.
- Seamless transition between full and mini modes in GTK.
- Zero orphaned UI components in the codebase.
