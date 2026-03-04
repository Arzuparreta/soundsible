# Discover design references

Short design research for the Discover recommendations UI. Implement to match project premium-glass style (see `.cursor/skills/premium-glass-ui-design/SKILL.md`).

## Reference UIs

1. **BBC Orbit – intentional discovery**  
   - *Concept:* User-controlled exploration; horizontal = similar tracks, vertical = different content; map-like exploration.  
   - *Reuse:* Card-based discovery; refresh to get new recommendations.  
   - [Designing for intentional discovery](https://www.bbc.co.uk/rd/articles/2025-03-orbit-music-discovery-design).

2. **Music discovery apps – mood/activity filtering**  
   - *Pattern:* Multiple entry points (search, mood, single track). Result lists as rows: cover + title + artist + action (add/play).  
   - *Reuse:* Result list = same row pattern as Search (div cover, title, artist, Add button). One primary action per row.  
   - [Building a music discovery app](https://bitsandmusic.com/post/building-music-discovery-app-4/).

## Constraints (premium-glass + project rules)

- **Clarity:** One focal area per section. No visual noise.
- **Depth:** Use blur + transparency (glass panels), not heavy shadows. Existing vars: `--surface-overlay`, `--glass-border`, `--accent`, `--text-dim`, `--text-main`.
- **Spacing:** 16px / 24px / 32px; 48px+ between sections. 4px or 8px base unit.
- **Radius:** 12px, 16px, or 24px only (e.g. `var(--radius-omni)` if defined).
- **Motion:** 200–350ms, ease-out. Respect `prefers-reduced-motion: reduce`.
- **Covers:** Do **not** use `<img>` for list or now-playing covers. Use `div` with `background-image` (project rule for PWA/long-press).
- **Touch targets:** Min 44px for interactive elements (mobile).

## Summary for implementation

- **Seeds:** Backend picks one library track with a valid YouTube ID; recommendations come from YouTube Music mix (related) for that seed. No UI for picking seeds.
- **Discover UI:** Single-card (tinder-style) stack: one recommendation at a time with Prev/Next, Add, Play, and Refresh. Refresh fetches a new set; refill appends when near end of buffer.
- **Results:** Card = div cover, title, artist; actions Add-to-queue, Play preview. Same metadata pattern as ODST search.
- **Empty states:** "Add music from YouTube to your library to get recommendations." when library has no tracks with YouTube ID or API returns no_seeds; "No recommendations right now. Try again later." when API returns empty results.
