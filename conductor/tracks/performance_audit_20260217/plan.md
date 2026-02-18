# Implementation Plan: Performance Audit & Mini Player

## Phase 1: WebUI Performance
- [x] Audit `ui.js` for layout thrashing.
- [x] Optimize `touchmove` logic with state-aware updates.
- [x] Fix `#omni-label-container` positioning in `index.html`.

## Phase 2: GTK Mini Mode
- [x] Introduce `Gtk.Stack` into `MainWindow`.
- [x] Migrate `_init_mini_player_ui` from snippet to `main.py`.
- [x] Implement `on_mini_mode_toggled` and bind F12.
- [x] Sync artwork and progress across modes.

## Phase 3: Cleanup
- [x] Remove orphaned `player/ui/mini_ui_snippet.py`.
- [x] Verify static `UI` class references in WebUI.
