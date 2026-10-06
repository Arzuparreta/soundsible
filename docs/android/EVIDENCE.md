# Evidencia del port Android

Una fila por bloque validado desde 2026-10-06. Lo anterior: `evidence/*.json` y
`SLICE_*.md` (S0–S2av). Los logs `/tmp` no sobreviven a un reinicio; la fila y el
commit son la referencia. «Normal» = APK normal + APK de test + JVM + lint del runner.

| Fecha | Bloque | Commit | Nativo | Otras | Log |
| --- | --- | --- | --- | --- | --- |
| 2026-10-06 | S2at invitaciones SEND + menú de pendiente | bf9fac69 | 8/0 HTTP/TLS 66.4s + normal | UI 211/1620 | /tmp/soundsible-incoming-invite-native.log |
| 2026-10-06 | S2au Ajustes de servidor y dispositivo | 90e9d1ef | 22/0 HTTP/TLS 280.5s + normal | UI 213/1631 | /tmp/soundsible-settings-block-native.log |
| 2026-10-06 | S2av sesión por QR/código | 118b2389 | 20/0 HTTP/TLS 235.8s + normal (JVM 59) | Core 78, UI 215/1637 | /tmp/soundsible-pairing-block-native.log |
| 2026-10-06 | S2aw menú de canción: artista/álbum, no me interesa, reproducir en otro dispositivo | bf30a361 | 22/0 HTTP/TLS 237.3s + normal (SongMenu + 9 clases que usan el menú) | UI 216/1643 | /tmp/soundsible-song-menu-native.log |
| 2026-10-06 | Podcasts: Top/recomendados (suscribir, motivo, no me interesa) y «sólo descargados» | ef28dddf | PodcastTop 1/0 HTTP + Podcast/PodcastDirectory 4/0 HTTP/TLS, 52.0s + normal. Esperas de «Downloaded» en esos tests eran ambiguas con el nuevo botón: ahora miran la fila. Fixture: ranking Apple simulado (antes salía a internet) | UI 216/1646, fixture Core 1/0 | /tmp/soundsible-podcasts-native.log |
| 2026-10-06 | Biblioteca: ordenar/filtrar canciones (preferencias compartidas con la web), álbumes por orden del motor y género/año | 72bbe127 | 12/0 en 167.4s + normal: radio de impacto (FileDeletion, OfflineRemoval, EntityBookmarks, Connection, CollectionProfile, LibraryActions, Offline); HTTP salvo clases sin variante | UI 216/1648 | /tmp/soundsible-library-native.log |
| 2026-10-06 | Cola con carriles de la web (contexto/peticiones), «Vaciar peticiones», «Reanudar» desde otro dispositivo | (este commit) | QueueLanes 1/0 HTTP + radio de impacto 11 métodos HTTP (Playback, Radio, Autoplay, Device*, LibraryActions, DevicesUi, PlannerRetirement) 265.3s + normal; Radio/Autoplay ajustados a la regla web (la petición va tras la actual) | UI 217/1654 | /tmp/soundsible-queue-native.log, /tmp/soundsible-queue-native-2.log |
