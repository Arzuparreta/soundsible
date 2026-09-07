# Content-first mobile lists

Below 1024 CSS pixels, content rows use `MusicListRow`: left-aligned title and subtitle, artwork, then a single overflow button. The artwork and text keep the existing primary action. The overflow button and primary button are siblings, with independent keyboard and touch handling. Desktop composition and card grids remain separate.

## Behaviour

- Library, favourites, artist/album tracks, mixed local search, online search, the player browser, playlists, podcast results/episodes, queue, DJ route and DJ sources use the shared mobile composition.
- Collection controls, queue removal and DJ row actions live in the existing action sheet. Catalogue/download adapters retain saved identity keys and surface-specific download handlers. Opening a sheet does not save, resolve or download an item.
- Favourite artwork marks appear only where they add information. Favourite lists suppress them. Active resolution/download temporarily takes the mark's place; owning a file adds no permanent mark.
- Functional route state stays in the subtitle. Current playback retains its existing treatment. Artwork placeholders, dimensions and overflow geometry remain stable as state changes.
- Native scrolling owns pans. Movement beyond the existing tap slop, pointer cancellation and a completed hold suppress the subsequent compatibility click. Keyboard activation remains available.
- A hold opens the menu. Queue **Move** exposes up/down/done controls below the content; DJ **Move** enters the existing destination placement flow. Prepared handoffs cannot enter move mode. Queue removal and movement address an occurrence, not just its track ID.
- Menu targets are at least 44 CSS pixels. Row/artwork sizes follow the existing interface-size tokens. The breakpoint is independent of the large-interface sidebar breakpoint.

## Development and review

`/player/#/preview` includes representative rows with long titles, missing artwork, favourite-context suppression, busy artwork and DJ state. Examples use local preview handlers.

Run `npm test` from `ui_web`, then:

```sh
SOUNDSIBLE_UI_TEST_PORT=4175 npm run test:ui-scale -- tests/browser/mobile-lists.spec.ts
```

The optional port isolates browser runs in separate worktrees. Vite starts from that checkout; dependencies must be installed there so self-hosted fonts are served correctly. CI covers the bundle.

Automated coverage includes 320/390/430 CSS pixels, landscape, all interface sizes, both themes, the 1023/1024 boundary, Chromium/WebKit, keyboard/menu isolation, native Chromium touch scrolling, contextual favourite marks and action availability. Queue, player and hold-gesture suites cover the existing interactions.

## Physical acceptance still required

On an actual phone, browse long lists with the usual one-handed grip, stop kinetic scrolling, play a song, use the menu, mark a favourite, download and reorder. Repeat with both hands and larger text. Confirm that intentional actions remain comfortable and that scrolling does not trigger them. Browser emulation verifies layout and event handling; it does not establish the ergonomic benefit of this layout. Extending the visual language to desktop is a separate decision after this review.
