# Discover arrives on the feed (2026-11-18)

Before/after captures for the change that stops Discover's search field from
taking focus on its own.

## What changed

- `routes/Search.tsx` focused the field on every mount when the pointer was
  fine (`(hover: hover) and (pointer: fine)`, i.e. desktop). Focus opens the
  recent searches over the feed, and the window shortcuts skip a focused text
  field, so Space, the arrow keys and the letter shortcuts did nothing on
  Discover until Escape or a click elsewhere. Back from an album or artist
  remounts the route, so it happened again on every return.
- The mount no longer focuses the field. It takes focus when the listener asks
  to search: a click on it, choosing Discover again while already at its top
  (`reselectPrimaryTab`, unchanged), or the new `/` shortcut.
- `/` (`lib/shortcuts.ts`, `lib/searchFocus.ts`) works from any page: it closes
  Now Playing, opens Discover's search as it was left and selects the query.
  A modal dialog keeps the key, and a text field types it.

## Captures

Chromium, fixture engine (`tests/browser/music-browser-fixture.ts`), dark theme,
Spanish copy, 1366×768 (`chromium-desktop` profile). One recent search
("Extremoduro") exists and the field is empty.

| Step | Before | After |
| --- | --- | --- |
| Library → Discover from the sidebar | [Before](desktop-sidebar-before.png) | [After](desktop-sidebar-after.png) |
| Discover → album → Back | [Before](desktop-back-before.png) | [After](desktop-back-after.png) |
| `/` after Back (new) | — | [After](desktop-slash-after.png) |

Phones never focused on arrival; their behaviour is unchanged.
