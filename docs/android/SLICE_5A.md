# S5a: Android Auto, biblioteca y selección del programa

Validado en AVD API36: **12/0 HTTP/TLS,94.079s**, runner exit0. Bloque conjunto
CarLibrary2 + CarLegacy2 + CatalogSearch2 + TransportReset2 + Connection4.
APK/test APK/JVM54/lint sin CA temporal pasan; Core car/playback11/0.
[evidence](evidence/s5a.json) registra provenance y límites. Development, no release.

MediaLibraryService sirve `/api/car/home`, `/api/car/items` y búsqueda autenticada
sobre música/podcasts adquiridos. Los resultados de búsqueda se filtran antes del
límite200. Las carpetas de feeds publicadas resuelven sólo episodios adquiridos
del perfil; feed desconocido devuelve404. Radio excluye episodios antes del límite.
Búsqueda moderna y `playFromSearch` clásico están probados; no hay reconocimiento
vocal probado ni búsqueda/adquisición implícita en proveedores externos.

Selección por ID publicado para generation/identidad activa; title/URI/extras del
caller no crean fuentes. ProgramQueue construye música/podcast nativos. Controllers
externos requieren trusted y no reciben append arbitrario ni comando privado de
cola. Descriptor Auto media y entrada MEDIA_PLAY_FROM_SEARCH empaquetados; sin
Android Automotive OS ni Car App Library templates.

Browse clásico sin páginas usa sentinel Int.MAX_VALUE: respuesta limitada a1000,
el máximo offline. Páginas normales1..200, registro1000 IDs y counts500 padres;
colas de worker16 y bodies256KiB. Hash/integridad offline fuera del looper de audio.
Suscripción inicial notifica total de hijos; actualización proactiva pendiente.
Requests/futures terminan al reset/close. Identidad/cookies/URLs del servidor no
se publican en metadata IPC.

Copias completas explícitas en «Disponible sin conexión». APIs503 permiten árbol
local y reproducción real.401 observado limpia copias/programa/grants;403 devuelve
permission denied sin cambiar cuenta. Cookie expirada sin401 y carátulas offline
tras muerte de proceso aún no aceptadas.

CarArtworkProvider no exportado: URI opaca con grant read al browser. Loader nativo
privado, registro400/cache32 PNG de hasta2MiB. Revoca registros y borra cache al
cambiar/cerrar cuenta. No revoca bytes o FD que el cliente ya recibió. Pruebas de
lectura/color/cache y revocación son sameUID; grants a UID externo pendientes.

Diagnósticos corregidos: límite/paginación legacy, redondeo JPEG en la prueba,
GUID JSON null interpretado como texto al seleccionar Radio, falta de browse de
feed, prueba que encolaba offline sin arrancar OfflineService y requisito lint de
play-from-search. Async transport obsoleto devolvía excepción unchecked que podía
matar OkHttp: ahora IOException por callback con guard de generation/origen,
probado en HTTP/TLS y servidor igual. Fix independiente f2a10c32.

Fuentes oficiales: [Android Auto media](https://developer.android.com/training/cars/media/auto),
[MediaLibraryService](https://developer.android.com/media/media3/session/serve-content).
La compatibilidad legacy/sentinel se verificó además en el bytecode de Media3
incluido por Gradle; protocolos reales ejecutados con MediaBrowser/MediaController.
No afirmar que sameUID sea Google Auto ni que AVD pruebe escucha/coche físico.

S5b pendiente: cambios proactivos/background, reconexión, controls/metadata durante
DJ, guard de generación en browse inicial, cookie expirada/offline y cliente de
UID externo. Host/DHU y aceptación física completa corresponden a beta.
