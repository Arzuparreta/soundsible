# Discover design references

Short design research for the Discover recommendations UI. Implement to match project premium-glass style (see `.cursor/skills/premium-glass-ui-design/SKILL.md`).

## Reference UIs

1. **Spotify Made for You / Mixes**  
   - *Access:* Search → Made for You (mobile); left menu Made For You (desktop).  
   - *Reuse:* Clear section labels ("Seeds" / "Based on these"), compact rows for "your picks" vs "recommended" list, primary CTA to generate/refresh. Card layout for each mix (cover + title + short subtitle).  
   - [Spotify Mixes support](https://support.spotify.com/us/article/spotify-mixes/) (structure); [Made for You mixes](https://www.androidcentral.com/spotifys-new-personalized-mixes-will-give-you-more-your-favorite-artists) (overview).

2. **BBC Orbit – intentional discovery**  
   - *Concept:* User-controlled exploration; horizontal = similar tracks, vertical = different content; map-like exploration.  
   - *Reuse:* Emphasize user agency: explicit "pick seeds" then "Get recommendations" rather than auto-only. Clear empty state when no seeds selected.  
   - [Designing for intentional discovery](https://www.bbc.co.uk/rd/articles/2025-03-orbit-music-discovery-design).

3. **Music discovery apps – mood/activity filtering**  
   - *Pattern:* Multiple entry points (search, mood, single track). Result lists as rows: cover + title + artist + action (add/play).  
   - *Reuse:* Discover seeds = "entry point"; result list = same row pattern as Search (div cover, title, artist, Add button). One primary action per row.  
   - [Spotify UI/UX Case Study – discovery](https://philostories.com/spotify); [Building a music discovery app](https://bitsandmusic.com/post/building-music-discovery-app-4/).

## Constraints (premium-glass + project rules)

- **Clarity:** One focal area per section (seeds vs results). No visual noise.
- **Depth:** Use blur + transparency (glass panels), not heavy shadows. Existing vars: `--surface-overlay`, `--glass-border`, `--accent`, `--text-dim`, `--text-main`.
- **Spacing:** 16px / 24px / 32px; 48px+ between sections. 4px or 8px base unit.
- **Radius:** 12px, 16px, or 24px only (e.g. `var(--radius-omni)` if defined).
- **Motion:** 200–350ms, ease-out. Respect `prefers-reduced-motion: reduce`.
- **Covers:** Do **not** use `<img>` for list or now-playing covers. Use `div` with `background-image` (project rule for PWA/long-press).
- **Touch targets:** Min 44px for interactive elements (mobile).

## Summary for implementation

- Seeds: subtitle + selectable library rows (or chips) + optional "Use current track" chip.
- One primary CTA: "Get recommendations" (disabled when 0 seeds).
- Results: list of rows — div cover, title, artist, Add-to-queue button (same pattern as ODST search).
- Empty states: "Pick at least one track" when no seeds; "No recommendations" when API returns empty; "Connect Spotify in Settings" when service unavailable.
