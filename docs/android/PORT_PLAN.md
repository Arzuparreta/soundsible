# Slices y matriz de paridad

## Regla de avance

Cada slice termina con implementación, pruebas pertinentes, evidencia, actualización
del traspaso y commit enfocado. No hay publicación por completar un slice.
`S0`, el núcleo funcional de `S1` y los cortes `S2a`/`S2b`/`S2c`/`S2d`/`S2e`/`S2f`/`S2g`/`S2h` están implementados.
`S2` completo y posteriores siguen **pendientes**.
HTTP/HTTPS se prueban con fixture real; la aceptación pública/DNS/Tailscale de S1 sigue abierta; ver HANDOFF.
Una casilla sólo cambia con evidencia; interfaces y workflows no cuentan como
comportamiento validado. Mantener visibles capacidades añadidas a Solid mientras
se desarrolla el port para que la paridad no se congele en un inventario antiguo.

## Orden y dependencias

| Slice | Trabajo | Dependencia y salida verificable |
| --- | --- | --- |
| S0 | Documentación, entrada Solid, Capacitor, proyecto Kotlin, build/CI | APK local arrancada y puente nativo verificado; sin conexión ni audio. |
| S1 | Servidor, sesión, biblioteca y eventos | [Especificación de conexión](SLICE_1.md); misma cuenta en REST, imágenes y socket. |
| S2 | Reproducción NORMAL, podcasts, radio, previews, cola | S1; servicio Media3, streaming autenticado/Range, controles y reconexión. |
| S3 | DJ y ejecución del programa | S2 + prueba de mezcla/efectos/captura nativos; planificación Solid y ejecución robusta en background. |
| S4 | Live receptor y emisor | S3 + captura real del programa; listener independiente oye la emisión correcta. |
| S5 | Android Auto | S2/S3; servicio de biblioteca, estado/control coherentes y evidencia DHU/dispositivo. |
| S6 | Offline y distribución | Decisión offline resuelta; implementación si se aprueba, firma y actualización verificadas. |

La investigación offline puede hacerse en paralelo al desarrollo, pero **no está
autorizada su implementación**. La decisión no se resuelve por omisión al llegar
al slice de publicación.

## Inventario de capacidades y aceptación

| Capacidad requerida | Referencia actual | Aceptación Android | Estado Android |
| --- | --- | --- | --- |
| Arranque/UI/accesibilidad/locales/temas | `ui_web/src/boot`, `lib/i18n.tsx`, `styles/`, `tests/browser` | APK sin red carga assets, logo, fuentes y locale; tamaño, safe areas, teclado y Back revisados | S0; evidencia en HANDOFF |
| Cuenta/configuración/permisos | `lib/session.ts`, `routes/Settings.tsx`, `/api/auth/*` | Cuenta persistida y roles respetados; logout/cambio sin fuga; ajustes disponibles según permisos | Login/logout/roles y persistencia S1; Settings y aceptación remota pendientes |
| Biblioteca, entidades, favoritos, playlists, metadatos | `routes/Library.tsx`, `components/MusicListRow.tsx`, stores, `trackActions.tsx` | Mismas acciones y estados guardados; actualizaciones y errores recuperables | Lectura/colecciones/covers/eventos S1; edición y acciones pendientes |
| Búsqueda/descubrimiento/adquisición/importación | `routes/Search.tsx`, `lib/catalogItem.ts`, `routes/Migrate.tsx`, descargas | Flujo descubrir → guardar/adquirir → reproducir; proveedores fallidos y progreso; selector de archivos nativo | Pendiente |
| NORMAL y cola | `lib/audio/contracts.ts`, stores | Orden/ocurrencias, transporte y acciones de fila; seek/cambio/fin; fallos sin doble audio | S2h: cierre explícito sin perder cuenta, carátulas privadas de programa/cola/sesión/notificación, recuperación explícita de conexión, archivos, cola por ocurrencias, edición e inserción desde biblioteca, seek/fin/foco/servicio, contrato asíncrono y controles Solid con shuffle/repeat; UI completa/edición/reconexión extendida pendientes |
| Podcasts/radio/previews | `types/podcast.ts`, stores, `lib/api.ts` | Streaming y archivos reales, resume y ±15s, range correcto y preparación temporal | Pendiente |
| DJ | `components/AutoMode.tsx`, `stores/dj.ts`, `audio/mixer.ts`, `docs/AUTO_MODE.md` | Sesiones/contextos, dirección, edición, requests, técnicas/FX, metadata dominante, fallback y recuperación | Pendiente |
| Letras/compartir/multidispositivo | `components/LyricsPanel.tsx`, `lib/share.ts`, `stores/runtime.ts` | Letras temporizadas, compartir e invites/deep links; registro, handoff y controles en cuenta correcta | Pendiente |
| Live escuchar | `lib/community.ts` | Sala, controles, chat/directorio, reconexión y fin de sala; no recapturar audio recibido | Pendiente |
| Live emitir | `audio/capture.ts`, `docs/LIVE.md` | Programa completo al relay; volumen local independiente; pausas/silencio; listener oye y reconecta | Pendiente |
| Audio nativo/lockscreen/Bluetooth | PlaybackService Media3 | Estado/posición/metadata, focus y políticas de pausa en emulador; llamadas/Bluetooth y evidencia física para beta | Servicio/metadata/carátulas/notificación/foco probados en emulador; teléfono, llamadas/Bluetooth y lockscreen físico pendientes |
| Android Auto | `/api/car/*`, `docs/CAR_INTEGRATION.md` | Browse/play/control, errores/red y metadata durante DJ en contrato multimedia; DHU y coche para beta | Pendiente |
| Offline | [Decisión pendiente](OFFLINE_DECISION.md) | Decisión documentada; si se aprueba, vuelos/espacio/sync/UI validados | Sin decidir; gate de alpha |
| Actualizaciones/distribución | [Release gates](RELEASE_GATES.md) | Clave permanente, versión/code coherentes, actualización conserva datos y session | Pendiente |

Las referencias son puntos de entrada, no una lista exhaustiva de endpoints.
Antes de implementar cada fila inventariar las pantallas/acciones actuales y
sus tests. No marcar paridad si la pantalla existe pero su acción queda anulada.

## Evidencia por capacidad

Registrar fecha, commit/build-info (incluido `dirty`), comando/caso, resultado,
artifact/log y entorno (browser, emulador, teléfono, coche, proveedor/relay).
Separar lógica, empaquetado, integración y escucha. No reutilizar el verde de
WebKit como evidencia Android ni el verde Android como aceptación acústica.
Repetir sólo las capas afectadas al cambiar un contrato y mantener los gates
completos exigidos por AGENTS para cambios compartidos.
