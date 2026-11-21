# Discover row actions, header refresh placement & canonical feedback captures (`D3`)

Captured against the Vite dev server (`SOUNDSIBLE_DEV_ENGINE=http://127.0.0.1:9`) with mocked Discover API fixtures:

- `desktop-before.png`: Desktop Discover rows before `D3` (duration and save button only, no `…` overflow menu trigger).
- `mobile-before.png`: Mobile Discover layout baseline before `D3`.
- `desktop-after.png`: Desktop Discover home after moving `Actualizar` into the top `Descubrir` `ViewHeader` row (eliminating the blank gap above `"Artistas por descubrir"`) and adding grouped `+ …` row controls (`.actionStripe`).
- `desktop-menu-after.png`: Desktop popover opened from an unresolved Deezer recommendation row (`Canción Deezer`), exposing `Iniciar radio`, the muted recommendation reason (`Artistas similares según lo que escuchas`), and `No me interesa`.
- `mobile-after.png`: Mobile Discover home with the refresh icon placed cleanly in the top `AppBar` opposite `Descubrir`.
- `mobile-menu-after.png`: Mobile action sheet opened on the same unresolved Deezer recommendation row showing parity (`Iniciar radio`, reason, `No me interesa`).
