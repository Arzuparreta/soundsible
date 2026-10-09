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
| 2026-10-06 | Cola con carriles de la web (contexto/peticiones), «Vaciar peticiones», «Reanudar» desde otro dispositivo | 3ecf6b78 | QueueLanes 1/0 HTTP + radio de impacto 11 métodos HTTP (Playback, Radio, Autoplay, Device*, LibraryActions, DevicesUi, PlannerRetirement) 265.3s + normal; Radio/Autoplay ajustados a la regla web (la petición va tras la actual) | UI 217/1654 | /tmp/soundsible-queue-native.log, /tmp/soundsible-queue-native-2.log |
| 2026-10-06 | Descarga de catálogo con verificación del motor y «Elegir versión», DJ «Cambiar sesión», buscador de ajustes | 02dcecff | 11/0 HTTP 140.7s + normal (Acquisition descarga por el nuevo camino, CatalogSearch, CollectionReview×4, CollectionProfile×2, DjContext, SettingsServer, DevicesUi) | UI 217/1659 | /tmp/soundsible-catalog-dj-settings-native.log |
| 2026-10-06 | Auto: socket del coche agotado se retira y reintenta tras 30 s | c0bc6aaf | Sin la corrección CarEvents falla («Exhausted socket replaced…»); con ella CarEvents(http) + CarLibrary + CarDj 5/0 146.5s + normal | — | /tmp/soundsible-car-exhaustion-native.log |
| 2026-10-06 | DJ «Pedir todas» en grupo, cambio de sesión y permiso offline contextual | 18edb7ed | DjContext + DeviceDjSession HTTP 2/0, 15.249s; permiso real denegar 1/0 (6.045s) y permitir 1/0 (6.424s), copias completadas; APK/JVM/lint normales | UI 217/1660 + TypeScript | /tmp/soundsible-dj-group-final3.log, /tmp/soundsible-notification-deny.log, /tmp/soundsible-notification-allow.log |
| 2026-10-06 | Aislamiento de los smoke tests desktop | f06b0525 | — | Desktop smoke + fixture adquisición 6/0 (53.06s); carpetas de prueba vacías impiden migrar perfil/cache personales | /tmp/soundsible-core-isolation.log |
| 2026-10-06 | Regresión UI y los cuatro perfiles browser | 18edb7ed | — | UI 217/1660 + TS; Chromium móvil/escritorio 278/0, 66 skips (8.9m); WebKit móvil/escritorio 269/0, 75 skips (8.6m), suites completas en imagen CI/1 worker. Chromium local abortó con SIGILL de la librería del navegador; contenedor limpio | /tmp/soundsible-final-ui2.log, /tmp/soundsible-final-chromium-container.log, /tmp/soundsible-final-webkit.log |
| 2026-10-06 | Regresión Core completa | f06b0525 | — | pytest 1792/0, 788.45s; TMPDIR en disco y smoke tests aislados | /tmp/soundsible-final-core-clean.log |
| 2026-10-06 | Regresión nativa e aislamiento de casos; reloj compartido sin reinicios redundantes | b862562e | Principal HTTP/TLS: 211 ejecutados, 7 fallos iniciales (selección/contadores del fixture y reloj intermitente). Corregidos: fila exacta para artwork, contador de replay respecto a resolución previa, retirada de un candidato real; salida compartida evita play repetido y pausa de decoder recuperable. Mezclas/recuperación/catálogo 53/54 (710.142s), único fallo de doble limpieza del fixture; corregida, repetición y Connection/PlannerRetirement/Live/Auto 18/0 + APK/JVM/lint normales. La suite principal final se comprueba de nuevo en CI | Smoke sin red 1/0; Ruff y diff-check | /tmp/soundsible-final-native.log, /tmp/soundsible-audio-recovery-final.log, /tmp/soundsible-native-final-corrections.log, /tmp/soundsible-final-smoke.log |
| 2026-10-06 | Reinicios de proceso offline/Live | 685d7009 | Offline prepare + force-stop/offline 2/0 (6.478s + 3.246s); Live prepare + force-stop/resume 2/0 (4.998s + 4.494s). Runner concede permiso para estos protocolos sin diálogo; aceptación de permitir/denegar permanece en ensayos de instalación fresca | APK/JVM/lint normales | /tmp/soundsible-final-offline-restart2.log, /tmp/soundsible-final-live-restart.log |
| 2026-10-08 | Descarga desde la cola nativa y el catálogo nativo con la posición del disco (pista, disco, año, artista del álbum en Media3) | 4019329f | Cola: QueueLanes, Metadata, Lyrics, CarLegacy 7/0 HTTP/TLS 37.7s; catálogo: Acquisition, CatalogSearch, CollectionProfile, CollectionReview, DeviceCatalogSession, QueueLanes 19/0 HTTP/TLS 203.8s; APK/JVM/lint normales; JVM ProgramRelease 4/0 | UI 217/1678 + TS; Core 1836/0; WebKit 287/0; Chromium 295/1: music-links «separate tab» inestable también en main (4/10 en main, 8/10 en la rama con 3 workers) | /tmp/claude-1000/-mnt-storage-Git-projects-storage-soundsible/657e3ec0-546d-4f2b-8276-6021df6b681a/scratchpad/android-integration.log, …/android-integration2.log |
| 2026-10-08 | Posición del disco en el traspaso de cola entre dispositivos | fe010168 | DeviceSession, DeviceDjSession, DeviceReconnect, DeviceCatalogSession, DevicesUi, QueueLanes 11/0 HTTP/TLS 192.6s + APK/JVM/lint normales; JVM ProgramRelease 5/0 | — | /tmp/claude-1000/-mnt-storage-Git-projects-storage-soundsible/657e3ec0-546d-4f2b-8276-6021df6b681a/scratchpad/android-integration3.log |
| 2026-10-08 | Canciones guardadas conservan su disco; la fila de álbum o de cola sustituye el disco entero de una vista previa guardada | 044024da, 5a0eefce | Catálogo (044024da): Acquisition, CatalogSearch, CollectionProfile, DeviceCatalogSession 10/0 HTTP/TLS; cola (5a0eefce): QueueLanes, PendingQueueMenu, Metadata, Acquisition 7/0 HTTP/TLS; APK/JVM/lint normales | UI 218/1684 + TS; WebKit 287/0 y Chromium 295/1 (music-links «separate tab», inestable también en main) en d04ed311 | /tmp/claude-1000/-mnt-storage-Git-projects-storage-soundsible/657e3ec0-546d-4f2b-8276-6021df6b681a/scratchpad/android-integration6.log, /tmp/claude-1000/-mnt-storage-Git-projects-storage-soundsible/657e3ec0-546d-4f2b-8276-6021df6b681a/scratchpad/android-integration7.log |
| 2026-10-08 | AcquisitionTest sin carrera: el fixture retiene la descarga hasta que el test la ha visto en curso | 3cacd3bf | AcquisitionTest 3 rondas seguidas, 2/0 cada una (HTTP/TLS) | Fallo previo en CI del commit de v0.21.0 (shard 1, run 37787098297), verde al relanzar | /tmp/claude-1000/-mnt-storage-Git-projects-storage-soundsible/657e3ec0-546d-4f2b-8276-6021df6b681a/scratchpad/android-acq-1.log, …/android-acq-3.log |
| 2026-10-08 | Tick DJ sin cierre si la mezcla ha fallado; lector del relay Live con reintento ante 404 | ccaf0711 | LiveHost, LiveRelay, LiveListener, DjNetwork, DjContext, DjProgram, ProgramDjRecovery 2 rondas 28/0 cada una (HTTP/TLS) + protocolo live-restart OK | UI 218/1685 + TS; Chromium 296/0; WebKit 287/0 | /tmp/claude-1000/-mnt-storage-Git-projects-storage-soundsible/657e3ec0-546d-4f2b-8276-6021df6b681a/scratchpad/android-flaky-1.log, …/android-flaky-2.log, …/android-flaky-restart.log |
| 2026-10-08 | CoverPickerTest: segunda elección si MediaProvider no pudo abrir la imagen recién insertada | 7f2d77e7 | CoverPicker 3 rondas, 2/0 cada una (HTTP/TLS) | Fallo en CI (#316, shard 1): logcat con «Failed to prepare synthetic picker path» y «Cannot open content uri» | /tmp/claude-1000/-mnt-storage-Git-projects-storage-soundsible/657e3ec0-546d-4f2b-8276-6021df6b681a/scratchpad/android-cover-1.log, …/android-cover-3.log |
| 2026-10-09 | ProgramMixOutputTest: tras el seek correctivo del plato en espera, esperar a que decodificador y mezcla lo den por listo 300 ms seguidos | #322 | ProgramMixOutput completa 38/0 + CancelPreroll HTTP/TLS 2 rondas más, 2/0 cada una | Fallo en CI de main (run 37851116718, shard 2) y de una PR de docs (run 37806904135): «Corrected standby cue did not rebuffer» a los ~3 s, no al límite de 15 s | /tmp/claude-1000/-mnt-storage-Git-projects-storage-soundsible/ef8b274f-c9f6-4846-b61c-8cd35597bd7a/scratchpad/aint2.log, …/aint-cancel-2.log, …/aint-cancel-3.log |

La ejecución completa del commit de entrega y los checks de todas las plataformas
se consultan en la [PR #300](https://github.com/Arzuparreta/soundsible/pull/300/checks).
Los resultados locales anteriores no sustituyen esos checks del head vigente.

- Revisión PR #300: ambos P2 confirmados. Transporte REST reutilizado por origen/generación,
  pool retirado al reset; socket de dispositivos conserva transporte de lifecycle propio.
  Colecciones Auto paginadas en Core (máximo 200 por respuesta), total conservado;
  bridge legacy agrega páginas hasta 1000 y mantiene compatibilidad con respuestas anteriores.
  Core: test con 405 listas/podcasts, páginas sin solapamiento y parámetros inválidos;
  instrumentación Connection/CarLibrary añade reutilización/reset y páginas/legacy de 405 colecciones.
  Compilación y aceptación nativa del commit corregido se validan en CI de la PR.
- Regresión CI posterior: el transporte TLS retirado en background ya no aborta
  CarLibrary. La suite alcanzó 87 casos y detectó cancelación de artwork que podía
  completarse con error antes del listener, callbacks offline tras destruir la
  Activity y dos capturas de posición anteriores a asentarse la pausa. Artwork
  cancela resultados de generaciones retiradas; OfflinePlugin rechaza llamadas
  tardías (prueba determinista de llamada/respuesta de permiso tras destroy);
  IncomingTrack espera posición estable sin ampliar la tolerancia. Regresión
  completa del head corregido pendiente de los checks de la PR.

## Preparación de distribución (2026-10-07)

- PR #300 integrada; ejecución Android de `main` 37601072712: build/JVM/lint y
  cuatro shards aprobados. El run anterior falló en la posición pausada de
  DjContextTest; ahora la referencia se toma de una conexión nueva al servicio,
  no del estado optimista del controller previo. Tolerancia conservada (150 ms).
- Tooling de release y versionado: 35 tests aprobados. Pruebas adicionales
  comprueban gates incompletos, reserva de códigos de drafts fallidos, checks
  nativos completos, inmutabilidad y rechazo de recibos de otra APK.
- Clave permanente/backup: exportaciones idénticas del certificado desde dos
  discos físicos; SHA-256 público en SIGNING.json. Secrets restringidos a main.
- App Links: PR Arzuparreta.github.io #11 integrada; endpoint HTTPS devuelve
  200 y application/json, con asociación al package/certificado permanente.
- DjContextTest con referencia confirmada por el servicio: HTTP/TLS 2/0,
  APK/JVM/lint normales aprobados; log /tmp/soundsible-alpha-dj-confirmed.log.
- APK pública local del commit 1a7332fb: firma permanente y cuatro ABIs verificadas;
  StartupTest release 1/0; actualización desde baseline firmada con la misma clave
  conserva cookie cifrada, cuenta, idioma/tema y metadata/copias offline. Offline
  prepare/seed/update/PCM 4/0; downgrade, firma distinta y APK truncada rechazados.
  App Links: dominio verificado por Android, apertura fría/caliente por resolución
  HTTPS real y rutas ajenas no reclamadas. Recibo en android/build/alpha/release-acceptance.json;
  log /tmp/soundsible-alpha-release-acceptance4.log. Publicación desde main requiere
  repetir la aceptación sobre su APK exacta en el workflow de release.
- Web pública: PR soundsible.github.io #14 integrada/desplegada; 84 tests de lógica,
  build Astro/check de 114 páginas y browser/accessibility 24/0 en imagen CI.
  No se muestran enlaces Android mientras no exista prerelease con todos los assets.


## Alpha pública y revisión final (2026-10-07)

- PR #304 integrada en main `88033c20e8953335e2e06ab1c973ece43f7b5968`.
  Codex completó la revisión del head final, sin nuevos hallazgos. Se corrigieron
  los problemas confirmados: base pública real y su harness para actualizaciones,
  SDK histórico, guarda de main antes de publicar, comparación semántica de
  copias offline, lint requerido, reinicios dirigidos y payload visible de App Links.
  El supuesto UnboundLocalError se descartó al comprobar la inicialización existente.
  Tooling release: 20 tests y Ruff aprobados; snapshot offline: 2 casos aprobados.
- [CI Android de main](https://github.com/Arzuparreta/soundsible/actions/runs/37620771168):
  build/JVM/lint y cuatro shards aprobados.
  [CI compartida](https://github.com/Arzuparreta/soundsible/actions/runs/37620771136)
  aprobada, incluyendo tests, lint, seguridad, UI/browser y consistencia de versión.
- [Workflow de publicación](https://github.com/Arzuparreta/soundsible/actions/runs/37623396866)
  aprobado. [Metadata inmutable de la alpha pública](https://api.github.com/repos/Arzuparreta/soundsible/releases/405757139),
  código público 2, source main `88033c20`, firma permanente y cuatro ABIs.
  SHA-256 APK: `2e243da454af6f6457085a274376e9b955cce0d7e77b3ce5316322cd14d0d4f8`.
  Todos los assets descargados pasan SHA256SUMS. El recibo público confirma
  actualización preservando cuenta/ajustes/offline, downgrade/firma distinta/APK
  corrupta rechazados, arranque, PCM offline y App Links con payload frío/caliente.
  Primera base sintética de código 1; releases posteriores usan la APK pública real.
  Prerelease pública, sin mover el latest global (release ID 405574473).
- Ensayo local posterior: candidato privado código 3, sin reserva ni publicación,
  instalado sobre la APK pública código 2 descargada y sembrada con su propio
  harness. Todos los flags de aceptación aprobados, incluida conservación de
  cuenta/ajustes/offline. Logs /tmp/soundsible-alpha-published-upgrade-{plan,build,acceptance}.log.
- [Web desplegada](https://github.com/Arzuparreta/soundsible.github.io/actions/runs/37624949108):
  comprobación browser live de descargas/checksums ES/EN, botón nativo Android,
  cápsula preservada al enviar al reproductor web guardado y cápsula inválida sin
  acción Android. Capturas /tmp/soundsible-alpha-download-{en,es}.png y
  /tmp/soundsible-alpha-android-sharing.png.
- Sin teléfono físico: escucha, Bluetooth, coche y proveedores reales siguen
  pendientes para beta; esta evidencia automatizada no los sustituye.
