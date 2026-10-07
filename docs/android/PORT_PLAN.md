# Slices y matriz de paridad

## Regla de avance

Cada slice termina con implementación, pruebas pertinentes, evidencia, actualización
del traspaso y commit enfocado. No hay publicación por completar un slice.
El inventario funcional del 2026-10-06 está implementado: teléfono, NORMAL,
DJ, Live, Android Auto, cuenta/ajustes y offline B. El cierre de pruebas y la PR
se registran en [HANDOFF](HANDOFF.md) y [EVIDENCE](EVIDENCE.md). La matriz
siguiente conserva las referencias históricas por capacidad; los pendientes
funcionales de esos cortes se completaron en los bloques posteriores de EVIDENCE.
No equivale a una publicación: firma/actualización/App Links son gates de
[RELEASE_GATES](RELEASE_GATES.md), y teléfono/Bluetooth/DHU/coche requieren
aceptación física para beta. Los proveedores públicos no se validan con fixtures.
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

Offline B está aprobado (2026-10-03): copias explícitas de música adquirida,
«Disponible sin conexión» dentro de menús. Su implementación y aceptación se
adelantan en el corte S6a; no sustituyen la paridad restante ni habilitan alpha.
El usuario autoriza continuar autónomamente hasta paridad completa y subir avances.
La PR #300 fue revisada e integrada el 2026-10-07. El usuario autorizó después
preparar la firma/canal y completar merge/publicación al cerrar los gates de
RELEASE_GATES. La aceptación física permanece como requisito de beta.

## Inventario de capacidades y aceptación

| Capacidad requerida | Referencia actual | Aceptación Android | Estado Android |
| --- | --- | --- | --- |
| Arranque/UI/accesibilidad/locales/temas | `ui_web/src/boot`, `lib/i18n.tsx`, `styles/`, `tests/browser` | APK sin red carga assets, logo, fuentes y locale; tamaño, safe areas, teclado y Back revisados | S0; S2z Atrás nativo en detalles/modales/pestañas y raíz minimizada sin perder programa/sesión; evidencia en HANDOFF |
| Cuenta/configuración/permisos | `lib/session.ts`, `routes/Settings.tsx`, `/api/auth/*` | Cuenta persistida y roles respetados; logout/cambio sin fuga; ajustes disponibles según permisos | Login/logout/roles y persistencia S1; S2ac Cuenta compartida, edición/password confirmado, logout e historial por origen/cuenta HTTP/HTTPS aceptados; S2ad Apariencia/idioma/tamaño/contraste compartidos HTTP/HTTPS aceptados, regresión compartida en curso; S2ak: Personas admin compartido, creación/invite/disabled y denegación miembro HTTP/TLS aceptados; S2au Biblioteca/Descargas admin/Comunidad/Acerca de y nombre/emparejados de dispositivo con vistas compartidas HTTP/TLS aceptados; S2av inicio de sesión por QR/código de emparejamiento (sesión completa, revocable) HTTP/TLS aceptado; aceptación remota pendiente |
| Biblioteca, entidades, favoritos, playlists, metadatos | `routes/Library.tsx`, `components/MusicListRow.tsx`, stores, `trackActions.tsx` | Mismas acciones y estados guardados; actualizaciones y errores recuperables | Lectura/colecciones/covers/eventos S1; S2n favoritos explícitos/filtro y create/add playlist confirmados; S2o rename/duplicate/delete/order/cover y pertenencia por ocurrencia condicionados; S2r editor/IPC y S2s edición sin rehash con texto/sidecar/copia offline validados; S2t bookmarks de álbum/artist adquiridos confirmados; acciones de entidad/canción y orden/filtros completados en bloques posteriores |
| Búsqueda/descubrimiento/adquisición/importación | `routes/Search.tsx`, `lib/catalogItem.ts`, `routes/Migrate.tsx`, descargas | Flujo descubrir → guardar/adquirir → reproducir; proveedores fallidos y progreso; selector de archivos nativo | S2j: búsqueda de canciones, resolución, guardado/retirada y reproducción nativa; S2x adquisición real con progreso/retry/cancel y promoción de identidad validada; S2y selector OS/stream y jobs compartidos con CSV/restore/playlist HTTP/HTTPS validados; colecciones y descarga verificada con selector de versión completadas en bloques posteriores |
| NORMAL y cola | `lib/audio/contracts.ts`, stores | Orden/ocurrencias, transporte y acciones de fila; seek/cambio/fin; fallos sin doble audio | S2i: cola mixta local/preview y retry 429/503 acotado; cierre explícito sin perder cuenta, carátulas privadas de programa/cola/sesión/notificación, recuperación explícita de conexión, archivos, cola por ocurrencias, edición e inserción desde biblioteca, seek/fin/foco/servicio, contrato asíncrono y controles Solid con shuffle/repeat; carriles contexto/peticiones, vaciar peticiones y reanudar desde otro dispositivo completados en bloques posteriores |
| Podcasts/radio/previews | `types/podcast.ts`, stores, `lib/api.ts` | Streaming y archivos reales, resume y ±15s, range correcto y preparación temporal | S2i: previews guardados por proxy, cache completa/progresiva y Range con fixture; S2k: episodios por proxy, archivos adquiridos, resume/±15s y progreso nativo; S2l: directorio/seguimiento y adquisición real con retry/cancel; S2m: Radio NORMAL en servicio, seed/pausa/posición y prioridad manual, retry en background; S2p perfiles y refill en background validados; S2q primer vertical autoplay nativo, preferencias/threshold/repeat/refill; Radio/autoplay, recomendaciones y filtro descargados completados en bloques posteriores; proveedor vivo fuera del fixture |
| DJ | `components/AutoMode.tsx`, `stores/dj.ts`, `audio/mixer.ts`, `docs/AUTO_MODE.md` | Sesiones/contextos, dirección, edición, requests, técnicas/FX, metadata dominante, fallback y recuperación | S3b ejecuta Core → dos decoders → un AudioTrack; siete técnicas/FX, metadata dominante, From current y apertura desde fuentes, perfiles/dirección, edición, refill y replan efectivos, toggle de mezcla confirmado, controles/focus/noisy en AVD y retorno NORMAL validados. Recuperación previa a mezcla aceptada. Requests musicales/fijos, repair, cambio contextual/fuentes conservando actual y peticiones, menús de ruta y ownership de bridges validados; recuperación de una entrada sin PCM y de body pendiente aceptadas. Ambas entradas PCM detenidas y retorno de una sana, y cola1000/recorte/append/resume por servicio+MediaController validados HTTP/TLS. DjNetworkTest cubre 503 persistente en ambos streams; peticiones en grupo y cambio de sesión implementados. Regresión final en EVIDENCE; aceptación física pendiente |
| Letras/compartir/multidispositivo | `components/LyricsPanel.tsx`, `lib/share.ts`, `stores/runtime.ts` | Letras temporizadas, compartir e invites/deep links; registro, handoff y controles en cuenta correcta | S2w letras adquirido/preview compartidas con seek nativo validadas; S2ah compartir canción por selector nativo, cápsula común o texto, validado HTTP/TLS con Intent interceptado; S2ai recepción pública VIEW/SEND fría/caliente y recreate HTTP/TLS validada; S2aj: registro por invite pegado en conexión, cookie/perfil/biblioteca aislada/recreate/reuso rechazado HTTP/TLS aceptados; S2at invite compartido como texto (SEND) sin cambiar origen/cuenta hasta acción explícita, con sesión iniciada aviso y cierre de sesión sólo al usarla, HTTP/TLS aceptado; puente público/App Links (VIEW de enlaces https): gate de publicación; S2al registro/controles remotos sin Activity y handoff NORMAL de entrada HTTP/TLS aceptados; S2am lista/controles de dispositivos desde Settings y contrato socket_active aceptados; S2an salida NORMAL y S2ao workspace DJ entrada/salida, controles y rechazo de perfil inválido HTTP/TLS aceptados; S2ap Radio/Autoplay ownership entrada/salida y Stop con manual conservado HTTP/TLS aceptados; S2aq reconexión larga, S2ar/S2as catálogo diferido y S2at menú de ocurrencia pendiente sólo con retirar aceptados |
| Live escuchar | `lib/community.ts` | Sala, controles, chat/directorio, reconexión y fin de sala; no recapturar audio recibido | S4b–S4e: WHEP TLS real, PCM/MediaSession, controls/guest metadata/chat, directorio y UI HTTP/TLS aceptados; fin/stop-prepare/vuelta a NORMAL y no recaptura. S4f: artwork público validado en MediaSession; S4g: corte real de listener recupera conservando pausa/volumen; S4h: autorización antes de WHEP, rechazo sin PCM, pérdida de lease y polling35s aceptados; S4i: reinicio de proceso con cookie cifrada, misma sala/seq/PCM aceptado; S4j: agotamiento real, recovery manual, reset durante TLS, foco/noisy del sistema aceptados HTTP/TLS; S4l: decks/mezcla/pausa/thumbnail visible y share público por chooser aceptados; regresión final en EVIDENCE; aceptación física pendiente |
| Live emitir | `audio/capture.ts`, `docs/LIVE.md` | Programa completo al relay; volumen local independiente; pausas/silencio; listener oye y reconecta | S4a–S4e: programa NORMAL Core HTTP/TLS → PCM JNI sin micrófono → WHIP TLS/MediaMTX → WHEP/PCM; mute local/silencio/resume, host servicio/heartbeat sin Activity, título/chat/fin y UI reales. S4f: DJ real al relay con metadata de transición y carátula pública de NORMAL validados HTTP/TLS; S4g: corte real de publisher recupera misma sala/PCM y handshake TLS cancelable; S4h: autorización antes de WHIP y pérdida real de lease en background aceptadas; S4i: resume409 retira publisher real, conserva sala/seq y protege cleanup tardío; reinicio aceptado; S4k: agotamiento del publisher en background conserva música/KEY, recovery explícito misma sala y reset durante retry aceptados HTTP/TLS; S4l: decks/mezcla/pausa/thumbnail visible y share público por chooser aceptados; regresión final en EVIDENCE; aceptación física pendiente |
| Audio nativo/lockscreen/Bluetooth | PlaybackService Media3 | Estado/posición/metadata, focus y políticas de pausa en emulador; llamadas/Bluetooth y evidencia física para beta | Servicio/metadata/carátulas/notificación/foco probados en emulador; teléfono, llamadas/Bluetooth y lockscreen físico pendientes |
| Android Auto | `/api/car/*`, `docs/CAR_INTEGRATION.md` | Browse/play/control, errores/red y metadata durante DJ en contrato multimedia; DHU y coche para beta | S5a: árbol autenticado, selección canónica, música/podcasts/Radio, búsqueda/playFromSearch, artwork por URI opaca, offline503 y401, protocolos moderno/clásico HTTP/TLS validados en bloque12/0 + normal APK/test/JVM54/lint. S5b: eventos de árbol en background con Activity cerrada, KEY/PCM y unsubscribe aceptados8/0 + normal. S5c: root/search/play de copias con cookie expirada y APIs503 aceptados8/0 + normal. S5d: señales de cache/copia completada/retirada actualizan Auto con Activity cerrada o cookie expirada,8/0 + extensión2/0 + normal. S5e: browsers moderno/clásico retienen DJ al browse/pausa/seek/resume y reflejan canción dominante,2/0 HTTP/TLS + normal. S5f: transporte cerrado/reintento503 y reconexión recuperan labels con Activity cerrada conservando NORMAL KEY/PCM,2/0 + normal. S5g: otro UID sin trust rechazado; listener autorizado lee artwork opaco, write denegado,6/0 HTTP/TLS + normal. S5h: otro UID playFromMediaId produce PCM/ID canónico y logout impide reabrir URI concedida,2/0 HTTP/TLS + normal. Labels de programa activo y agotamiento de retries corregidos/validados en CarDjTest/CarEventsTest; host/DHU físico para beta |
| Offline | [Decisión aprobada](OFFLINE_DECISION.md) | Copias completas, vuelos/espacio/cuenta/UI validados | S6a implementado/validado en emulador; evidencia en HANDOFF. Alpha requiere además paridad completa |
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

S2aa añade retirada confirmada de adquirido y referencias locales/copias; copia
borrada por otro cliente permanece retirable. Cuatro casos HTTP/HTTPS y gestor
filesystem recuperable validados. Ver [evidencia](evidence/s2aa.json). S2ab acepta el planner
deliberadamente retrasado en Radio/autoplay HTTP/HTTPS; principal limpia53+restart2
aceptada. Registro histórico de S2ab; el cierre posterior figura en EVIDENCE. No equivale a publicación.
