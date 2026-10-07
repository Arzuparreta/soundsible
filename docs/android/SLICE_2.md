# S2: primer programa de audio nativo

## Primer corte vertical

Una canción real de la biblioteca pasa de la fila Solid a un servicio Android
Media3 autenticado: play/pause/seek/fin, metadata/posición y controles de pantalla
bloqueada siguen el mismo estado, incluso con la Activity recreada o en segundo
plano. Una sola fuente/cola NORMAL al comienzo; no DJ, Live, offline ni publicación.
Este corte es la base del S2 completo (podcasts, radio, previews y handoff), no
permiso para una alpha recortada.

## Trabajo concreto

1. Leer `AudioService` y stores actuales. Definir comandos/snapshots asíncronos y
   generaciones antes de montar `AuthenticatedPlayer`. No suplantar operaciones
   síncronas devolviendo éxito de un puente aún pendiente.
2. Añadir MediaLibraryService/MediaSession y una fuente HTTP que usa la cookie
   protegida de EngineConnection. Conservar Range y errores 401/403 sin exponer
   el secreto por JS/URLs ni seguir redirects autenticados. El proxy actual de
   WebView sólo admite covers: no usarlo como transporte de audio.
3. Extraer/adaptar el runtime compartido: biblioteca y filas usan los mismos
   contratos; la variante Android no importa/instancia AudioContext ni HTMLAudio.
   Volver a usar rutas/acciones Solid completas a medida que el runtime exista;
   retirar la superficie de lectura temporal cuando tenga reemplazo probado.
4. Mantener el servicio como dueño del programa, con foco/política de pausa y
   comandos OS. Activity en foreground sólo observa; no publica otro estado ni
   reconstruye una cola al girar/recrear.
5. Logout/cambio cancela audio y recursos antes de otra cuenta; 401 revocado
   para el servicio. Una red caída conserva estado recuperable sin afirmar que
   esté sonando. No activar Web Audio como fallback en Android.

## Pruebas y entrega

Extender el fixture desechable con audio corto propio y respuestas Range reales.
En APK instrumentada: orden y ocurrencias de cola, posición/seek, pausa/fin,
recreación/background, foco, metadata/media controls, 401, servidor caído y
cambio de cuenta en vuelo. Probar el happy path HTTPS válido pendiente de S1.
Separar estado/progreso observado de escucha acústica: emulador no demuestra
Bluetooth, llamadas, Android Auto o coche real.

Ejecutar tests de contratos, build/lint/Android y cuatro perfiles browser tras
cambios UI. Actualizar matriz/evidencia/HANDOFF y cerrar con commit enfocado.
Push autorizado para esta línea de trabajo; PR/merge/publicación no solicitados.


## Contrato del primer corte (S2a)

`SoundsiblePlayback.command` es asíncrono. Su resolución confirma aceptación del
comando por el controlador, no sonido audible: `playing` sólo procede de
`ExoPlayer.isPlaying`. Estado nativo: generación, id/índice/ids de cola,
posición/duración en ms, readiness y error/status HTTP. Las ocurrencias conservan
su índice aunque repitan id. No se adapta aún la interfaz síncrona de mezcla
`AudioService`; ese cambio corresponde a la integración del runtime completo.

`PlaybackService` aloja un ExoPlayer y MediaLibrarySession. `PlaybackPlugin`
conecta un MediaController de la app y sólo recibe ids/metadatos, nunca URLs o
cookies de JS. Los comandos se validan contra la generación de EngineConnection.
El origen/cookie viven en una conexión del proceso: destruir la Activity cierra
su socket/controlador, no la conexión de reproducción. Logout/configuración
cancelan el cliente audio y vacían el programa. No hay resumption tras muerte del
proceso en este corte; no persistir una cola privada como si se hubiese aprobado.

El DataSource OkHttp comparte la política HTTP privado/HTTPS de S1. Cada fuente
incluye una generación interna que se comprueba antes de enviar cookie, y se
retira antes del HTTP. Preserva Range; no sigue redirects ni usa cache de audio.
401 detiene el intento y la UI revalida identidad para volver al login; 403 se
muestra como permiso denegado. Otros fallos conservan la cola y permiten reintentar
con Play. No hay fallback Web Audio ni descarga local.

Los controles OS observan la misma sesión. Sólo el UID de la aplicación puede
reemplazar la cola; clientes externos deben ser trusted y no reciben comandos
para inyectar fuentes. El servicio todavía no ofrece un catálogo de browsing:
**MediaLibrarySession no significa Android Auto implementado**. Título/artista
son metadata nativa; S2g añade carátulas privadas a la sesión/notificación.

La superficie de desarrollo activa archivos locales en las filas/virtualización
Solid compartidas y ofrece transporte/seek básicos. Las canciones preview siguen
visibles y desactivadas. Cola de desarrollo limitada a 1.000 archivos; edición,
shuffle/repeat, cola extensa por lotes y rutas completas quedan pendientes.
No marcar NORMAL entero ni S2 completo como terminados.

## Continuación después de S2a

1. Integrar el contrato asíncrono de programa con el runtime autenticado Solid,
   retirando los controles temporales y conservando las acciones/estado de cola.
2. Extender fuentes: previews, podcasts/resume/±15s y radio con casos reales,
   protección de origen, persistencia autorizada y errores de proveedor.
3. Añadir artwork nativo de sesión, aceptación de notificación/lockscreen,
   ruido/desconexión de auriculares y redes en teléfono; foreground con app fuera
   de recientes y política explícita de process death/resumption.
4. Mantener DJ/Live/Android Auto/offline como gates independientes. No publicar.

Referencias primarias usadas para servicio/foreground/controladores y transporte:
[background playback](https://developer.android.com/media/media3/session/background-playback),
[network stacks](https://developer.android.com/media/media3/exoplayer/network-stacks).

## S2b: modos nativos de cola

El puente nativo acepta `shuffle` con `enabled` booleano obligatorio y `repeat`
con `mode` obligatorio (0 off, 1 una canción, 2 toda la cola). Valida generación y
comando disponible antes de mutar el controlador. Snapshot/evento añaden `shuffle`,
`repeat`, `hasNext` y `hasPrevious`; éstos proceden de Media3, no se calculan por
`index + 1`. Los índices siguen identificando ocurrencias en el orden original.

Los modos sobreviven a recreación/background junto al servicio y se restablecen
al cambiar la cuenta/origen o cerrar sesión. No se persisten tras muerte del
proceso. Este corte es el contrato nativo: los botones y el tipado Solid compartido
se incorporarán con el runtime autenticado; no afirmar que la UI ofrece ya estas
acciones. El siguiente corte sigue siendo integrar ese runtime asíncrono, sin
adaptar la interfaz de mezcla síncrona con éxitos ficticios.

Semántica de modos e índices: [Media3 playlists](https://developer.android.com/media/media3/exoplayer/playlists).

## S2c: runtime asíncrono y transporte Solid

`ui_web/src/lib/program/runtime.ts` define el programa de una sola salida sin
importar Solid, Capacitor, stores del mezclador ni Web Audio. Contrato con comandos
como unión tipada (queue/play/pause/seek/next/previous/stop/shuffle/repeat), snapshot
nativo y suscripción. Android aporta `nativeProgramTransport`; cada snapshot
incluye `sequence`, creciente durante la vida del plugin. Esa secuencia no es un
reloj ni se persiste: evita que una respuesta retrasada reemplace un evento más
reciente de la misma generación. La generación impide cruzar cuentas.

El runtime escucha antes de leer el snapshot inicial, serializa los comandos y
publica pending sólo hasta su aceptación. No deriva `playing` de Play ni de la
resolución de la promesa. Un fallo no envenena el siguiente intento explícito.
Unbind descarta respuestas/errores anteriores y comandos aún en espera; libera
incluso una suscripción cuyo alta termina después. No cancela por sí solo el audio:
logout/configuración siguen usando la limpieza nativa de EngineConnection; destruir
la UI sólo deja de observar y no destruye el programa del servicio.

`ProgramTransport.tsx` sustituye el JSX de controles incrustado en AndroidStart y
no importa el store global de mezcla. Ofrece shuffle y repeat accesibles, pending,
play/pause/seek y navegación según `hasNext`/`hasPrevious` nativos: repeat-all puede
volver desde la última ocurrencia. El seek arrastrado no se pierde con los ticks,
y sí se limpia al cambiar la ocurrencia aunque el id se repita.

Este paso inicia la integración compartida, **no monta aún AuthenticatedPlayer ni
retira LibraryBrowser temporal**. Antes de hacerlo, adaptar explícitamente las
acciones/rutas NORMAL y el estado de cola al contrato asíncrono: el AudioService
síncrono de mezcla no es compatible. El componente está disponible para futuros
adaptadores; no se afirma que el navegador use ya este runtime. Fuentes pendientes,
artwork, DJ/Live/Auto/offline y aceptación física mantienen sus gates.

## S2d: cola NORMAL por ocurrencias

El snapshot añade `items` (key/id/título/artista/álbum) y `queueToken`, una huella
SHA-256 del orden de las claves. Cada entrada recibe un UUID nativo en
MediaMetadata.extras al crear la cola; repetir id conserva entradas independientes.
Las claves sobreviven en el servicio a recrear la Activity, no se persisten tras
muerte de proceso ni se aceptan de JS al crear fuentes. No se exportan URI/cookies.

Comandos tipados `select`/`move`/`remove` llevan index/key/queueToken y generación;
move incluye toIndex. Se envían como un comando custom de MediaSession disponible
sólo para el UID de la app. El servicio valida sesión/generación, huella de su cola
real, clave e índices antes de editar. Una petición con orden antiguo se rechaza,
aunque el id de la canción siga existiendo. La aceptación asíncrona no promete que
el nuevo snapshot del controlador haya llegado: la UI sigue observando eventos.

Seleccionar una aparición salta a su comienzo y pide Play explícito. Mover o
quitar otra fila usa las operaciones de Media3, conservando posición y estado
play/pausa de la actual. Quitar la actual delega el siguiente elemento en Media3;
si no queda sucesor, termina. Quitar la última entrada detiene y vacía el programa.
Los modos shuffle/repeat se conservan con estas ediciones y cola vacía; logout o
cambio de cuenta/origen siguen restableciéndolos. Semántica de modificaciones:
[Media3 playlists](https://developer.android.com/media/media3/exoplayer/playlists).

`ProgramQueue` muestra las filas con `MusicListRowView`, selección activa por
ocurrencia y controles de edición separados. Virtualiza el panel sin importar
stores/Web Audio; mide filas reales también en edición. Claves estables conservan
DOM entre ticks y reordenaciones; recupera foco al mover un nodo aún presente.
Los labels de acciones incluyen el índice para distinguir títulos repetidos.

Sigue siendo la superficie Android de desarrollo, no la UI NORMAL completa ni
un catálogo Android Auto. Límite de 1.000 archivos, sin append/adquisición,
previews/podcasts/radio/artwork/handoff ni resumption. No alpha ni offline.

## S2e: añadir desde biblioteca y colecciones

Las filas locales de LibraryBrowser abren el menú compartido (sheet en touch,
popover con ratón) con «Añadir después de la actual» y «Añadir a la cola».
Previews no ofrecen este menú; no hay adquisición nueva. Los callbacks no importan
stores de mezcla ni prometen confirmación antes de observar el servicio.

`append` lleva tracks/queueToken; `insertAfter` añade index/key de la ocurrencia
actual al abrir el menú. Ambos llevan generación y pasan por el custom command
restringido al UID. El servicio comprueba su orden real; para insertAfter comprueba
además que el ancla siga siendo la actual, incluso si un comando OS cambió de
canción sin cambiar el orden. Rechaza acciones antiguas sin modificar nada.
Una selección diferida del sheet no puede trasladarse a otra cuenta.

La factoría nativa compartida con `queue` sólo acepta ids/metadatos: no usa URI,
cookie ni key de JS. Cada inserción crea nuevos UUIDs, también para ids repetidos.
Valida el lote entero antes de añadir, el límite total de 1.000 y los límites de
id/metadatos. No reconstruye entradas existentes. Media3 mantiene la ocurrencia
actual, posición, play/pausa y modos al añadir durante reproducción o pausa.
Una cola vacía se prepara explícitamente en pausa, incluso si stop/clear había
conservado playWhenReady. No se llama prepare/play sobre una cola no vacía como
reintento implícito de un error. No se persiste el programa tras muerte del proceso.

«Después» significa la siguiente posición de la cola visible. Con shuffle activo,
Media3 conserva el orden aleatorio en lo posible; no se promete que esa nueva fila
suene inmediatamente después. Véase [playlist/shuffle de Media3](https://developer.android.com/media/media3/exoplayer/playlists).

La integración HTTP/HTTPS verificado comprueba acciones reales desde el menú,
claves nuevas/existentes, inserción intermedia, pausa/posición/modos, append mientras
suena, recreación de Activity, ancla antigua tras navegación OS, generación/orden
antiguos y lotes inválidos/demasiado grandes sin modificación parcial. Ver
[traspaso y resultados finales](HANDOFF_HISTORY.md#entrega-s2e).

## S2f: recuperación explícita de conexión

El snapshot distingue `playing` (audio nativo realmente en curso),
`playWhenReady` (intención de Play) y `errorKind`: connection/server/auth/permission/
source o vacío. La clasificación sigue la cadena de causas nativa: 401/403 tienen
semántica propia; 408/429/5xx son recuperables; errores de lectura/conexión HTTP
son connection. Certificados/handshake y errores de fuente no ofrecen Retry.
No se cambian confianza TLS, routing privado, origen ni cookie.

El transporte muestra buffering y permite Pause aunque todavía no haya audio.
Muestra el error recuperable con Retry, sin derivar éxito de aceptar un comando.
El comando `retry` captura generación, huella de cola y key/index actual; el servicio
valida esos datos y que su error real siga siendo recuperable. Sólo hace prepare
sobre el mismo player: conserva fuentes, claves, índice, posición y la intención
más reciente de Play/pausa. Una pausa queda pausada tras Retry; una intención de
Play se reanuda sólo al pedir Retry. El comando no sustituye la cola ni inicia una
sesión nueva. No ofrece recuperación automática al volver la red.

El datasource de audio desactiva el retry transparente de OkHttp. La política de
Media3 devuelve TIME_UNSET para el delay de retry, además de mínimo cero: sólo
cambiar el mínimo no define por sí solo todo el comportamiento de reintento.
Referencia: [política de carga](https://developer.android.com/reference/androidx/media3/exoplayer/upstream/DefaultLoadErrorHandlingPolicy).
Un read timeout de la conexión sigue delimitando una lectura bloqueada; no se
impone un timeout global que cortaría canciones largas. Semántica prepare/error e
intención: [eventos del player](https://developer.android.com/media/media3/exoplayer/listening-to-player-events).

Al recrear Activity con servidor inaccesible, el programa del servicio se muestra
sin necesitar otra respuesta de biblioteca. No se inventa identidad ni se guarda
una biblioteca offline. Retry de conexión revalida la cuenta con su cookie nativa;
fallos de red conservan el programa, 401 lo limpia incluso si no se había resuelto
la identidad de esta Activity, y 403 mantiene el estado de permiso sin tratarlo como
caída de red. Logout/cambio siguen borrando sesión antes de otra cuenta.

La prueba usa una respuesta WAV truncada después de sus headers (Content-Length
original) en el fixture aislado, no un error JS. Para recreación simula API no
disponible con 503 y permiso denegado con 403, y luego restaura el mismo servidor HTTP/HTTPS verificado.
Verifica posición pausada, claves/modos, ausencia de peticiones automáticas tras
fallo, reanudación con intención Play, rechazo de Retry ante 403 y limpieza por stream
401 aun sin identidad resuelta. El arranque local no espera esa revalidación. Sigue sin probar
apagado real de servidor, pérdida de cobertura del teléfono ni aceptación acústica.
No implementa caché de audio, persistencia tras process death ni offline aprobado.


## S2g: carátulas privadas del programa y sesión

`ProgramQueue.items` crea `artworkUri` desde el id validado y la generación nativa:
`soundsible-artwork://<generation>/<id>`. JS sigue enviando sólo ids/metadatos;
no puede suministrar origen, URI de imagen ni cookie al programa. El BitmapLoader
`ProgramArtwork` obtiene `/api/static/cover/<id>?size=thumb` en el origen seleccionado,
con cookie nativa y la misma política de HTTPS/HTTP privado de EngineConnection.
No sigue redirects, no intenta una imagen pública ante errores ni usa disco.
La sesión usa `MediaLibrarySession.Builder.setBitmapLoader`; el proveedor estándar
de notificación publica esa carátula. API contrastada con los JAR de Media3 fijados
en el proyecto y [documentación de MediaSession](https://developer.android.com/reference/androidx/media3/session/MediaSession.Builder#setBitmapLoader(androidx.media3.common.util.BitmapLoader)).

Dos workers y hasta 16 trabajos en espera limitan concurrencia. Cada petición tiene
8 segundos de timeout global y un máximo de 2 MiB de cuerpo, incluso sin Content-Length.
La decodificación inspecciona dimensiones antes de asignar bitmap: máximo 16 megapíxeles
de origen y muestreo hasta 512 px por lado. Se admiten PNG/JPEG/WebP. Sólo se conserva
el último future/bitmap en memoria para evitar descargas duplicadas de notificación y
sesión. Los errores se descartan para permitir otro intento al pedir la misma imagen;
no hay retry de red automático ni invalidación por edición de una carátula ya
cargada mientras siga siendo la última URI solicitada (también entre duplicados). Ese refresco queda pendiente de integrar los eventos
con el programa completo.

Logout/cambio de servidor cancelan futures y HTTP y descartan el resultado en memoria.
Antes de leer y publicar se comprueban generación y origen; una respuesta tardía de otra
cuenta no completa el future. Destruir Activity conserva el servicio/cargador; destruir
el servicio los libera. Fallos 404, bytes inválidos y tamaño excesivo sólo afectan a la
imagen: no vacían el programa, no generan error de audio ni convierten una imagen 401
en logout. El transporte de audio/identidad mantiene sus propias reglas de revocación.

Las superficies Solid de programa y cola reutilizan `coverUrl`/`coverStyle` y el proxy
local autenticado de S1. El gradiente existente permanece debajo si la imagen falla.
El proxy ahora limita también el cuerpo privado a 2 MiB y revalida generación durante
la lectura y antes de entregarlo; sus respuestas continúan siendo `no-store`.
Los límites de decodificación anteriores corresponden al cargador de sesión nativo,
no al decodificador del WebView.

Instrumentación: carátulas reales de dos cuentas por HTTP y HTTPS verificado, imágenes
ajenas sin fuga del color privado (placeholder o rechazo), URI externa/query rechazada,
duplicados, 404/bytes inválidos/cuerpo excesivo, cancelación en vuelo y cuenta posterior.
El programa verifica bitmap de metadata de la sesión Android y large icon de la
notificación con el color privado correcto, además de los casos existentes de
recreación, duplicados/edición, foco y recuperación. El encoder de miniaturas del motor
es JPEG: las pruebas admiten tres puntos por canal, no exigen píxel idéntico al PNG.
Esto no prueba escucha acústica, pantalla bloqueada física, Bluetooth ni Android Auto.


## S2h: cierre explícito del programa

El botón × de la cabecera lleva etiqueta accesible localizada “Cerrar reproductor”
y área mínima 44 × 44 px. Envía `stop` con generación y queueToken capturados; no
borra estado de UI por anticipado. Sólo el UID propio puede enviar ese custom command.
El servicio verifica generación y huella de la cola, incluso sin cookie/red disponible:
un cierre tardío de otro programa se rechaza. No depende de REST ni borra la cuenta.

En el looper del player: pausa, stop, vaciado de fuentes/ocurrencias, reset de
shuffle/repeat e intención, cancelación/limpieza del cargador de carátulas y del
cliente audio, incluida expulsión de conexiones idle del cliente retenido. En la
versión Media3 fijada, stop conserva un error anterior. Si sigue presente después
de vaciar, prepare sobre timeline vacío lo limpia y otro stop deja STATE_IDLE;
no hay fuente de audio ni petición de red en esa preparación. Se verificó en los
JAR reales de ExoPlayerImpl (`stopInternal`/`prepare`) y en el caso 503 instrumentado.

La respuesta del servicio confirma la mutación. El plugin espera además observar
por IPC cola vacía, intención falsa, modos por defecto, idle y error nulo antes de
resolver el snapshot (máximo 3 segundos, guardando generación/controlador). Un
snapshot sin items usa index -1, metadata vacía y posición/duración cero. El runtime
serializa las acciones posteriores; no presenta éxito a partir de una cola local
vacía. El error de confirmación permanece visible si se rechaza/no se observa.

El timeline vacío hace retirar notificación y foreground por el gestor estándar
de Media3; se solicita actualización sin cancelar un id de notificación manual.
La sesión/player siguen disponibles mientras hay controllers enlazados. No se
libera una sesión debajo de la Activity ni se guarda resumption en disco. El
loader de carátulas descarta su único resultado y cancela trabajos, conservando
su executor para una activación posterior; destroy libera ese executor.

Cerrar programa y retirar tarea de recientes son acciones distintas. No se
sobrescribe onTaskRemoved: la versión fijada conserva reproducción cuando existe
foreground y alguna sesión con isPlaying verdadero; de lo contrario llama a
pauseAllPlayersAndStopSelf. La destrucción final depende de los enlaces restantes.
[Contrato de servicio](https://developer.android.com/reference/androidx/media3/session/MediaSessionService) y
[reproducción en background](https://developer.android.com/media/media3/session/background-playback).
El test usa finishAndRemoveTask, un MediaController de instrumentación enlazado y
reapertura en API 36, conservando key/playing. No prueba swipe físico ni muerte del
proceso, auriculares/llamadas/Bluetooth o política de fabricantes.

Casos de cierre HTTP/HTTPS verificado: Play, pausa, buffering con headers retrasados,
error de audio 503 y API 503; metadata/artwork de sesión Android y notificación
retiradas; mismo cookie/generación; Activity recreada no reconstruye cola. Se
rechaza queueToken obsoleto. Append posterior tiene nuevas keys y permanece
pausado con modos por defecto; activar una fila explícitamente vuelve a reproducir.
Una respuesta del stream retrasado no resucita el programa después de cerrar.
La biblioteca se revalida por red al restaurar API: no es persistencia offline.


## S2i: previews guardados por el proxy del motor

El contrato de `ProgramTrack` exige `source: local | preview`. JS sólo envía id,
título, artista y álbum. La misma conversión controla filas, menús y colas mixtas;
excluye podcasts y previews sin id ASCII válido de once caracteres. El id preview
es `Track.id`, aunque exista un `youtube_id` distinto. Filtrar entradas no
reproducibles conserva el índice seleccionado y los duplicados; cada ocurrencia
recibe un UUID nuevo. Nativo rechaza todo el lote antes de modificar el programa
si una fuente/id/metadata no es válida.

Media3 construye `/api/static/stream/<id>` o `/api/preview/stream/<id>`. Los
marcadores internos de generación y ocurrencia se retiran antes del HTTP.
EngineConnection mantiene cookie, origen seleccionado, HTTP privado, TLS
verificado y rechazo de redirects. No se usa stream-url ni se recibe una URL
externa del puente. Previews tienen placeholder en programa, cola y metadata
nativa; las miniaturas de biblioteca conservan su transporte seguro.

El GET de audio inicia o comparte la adquisición del motor. No hay prefetch de
bytes ni descargas especulativas Android. PreviewProgram pertenece al servicio,
consulta status del preview actual cada segundo con una sola petición en vuelo
y publica extras de MediaSession asociados a generación/UUID. El snapshot añade
`preview` (o null), con `key`, `preparation`, `retryAttempt`, `retryPending` y
`retryNotBeforeMs`. Preparation conserva los estados/campos del API existente;
un dato ausente es desconocido. Poll termina en ready/unavailable/error/cambio/cierre; cold sólo se sondea
mientras el player sigue buffering. Su
fallo de red no reemplaza el error del audio; 401 pausa y expone sesión expirada.
`playing` siempre es ExoPlayer.isPlaying, nunca una respuesta queued/streamable.

Sólo los previews 429/503 tienen retry automático: dos reintentos como máximo,
iniciados en los treinta segundos tras el primer fallo. Retry-After admite
segundos y fecha HTTP; sin valor válido las esperas son dos y cuatro segundos.
Una espera superior al presupuesto termina en error recuperable conservando su
cooldown. El presupuesto pertenece al intento explícito/UUID/generación y no se
renueva por rangos o seeks. Retry manual renueva el presupuesto sólo tras el
cooldown; Play/Prepare y seleccionar la misma ocurrencia fallida no pueden
saltárselo. Archivos locales conservan la política S2f. Pausa no fuerza Play al
llegar bytes ni al completar un retry.

Cambiar/retirar ocurrencia, reemplazar cola, cerrar programa, cambiar cuenta o
destruir servicio cancela interés, sondeo, carga y espera propios. Mover el mismo
UUID conserva el intento. Las llamadas de audio se registran hasta callEnd o
callFailed, incluyendo cuerpos abiertos que ya no aparecen en el dispatcher de
OkHttp. La cancelación no invoca cancel global por vídeo: cerrar el lector deja
al motor cancelar únicamente cuando no queda otro lector/interés de prefetch.
Recrear/destruir Activity libera el controlador, sin terminar el programa.

El fixture extiende el motor desechable con proveedor localhost, AAC/MP4
con índice inicial, MP4 fragmentado y WebM/Opus sintetizados por ffmpeg. Sólo sustituye resolución; rutas,
cache, verificación de decodificación, prefix/rate y Range son los reales. Nunca
resuelve fuera del fixture. Los controles de fallo/progreso siguen aislados en
localhost. La prueba Python comprueba cache/rangos y que cerrar un lector no
corta a otro; instrumentación comprueba el recorrido empaquetado HTTP/HTTPS.
Proveedor vivo, teléfono, escucha física, Bluetooth/coche/lockscreen físico y
resumption tras process death siguen sin aceptación. Cache del motor no es
cache offline Android. Ver evidencia y traspaso antes de continuar.


En respuestas `X-Soundsible-Playback-Cache: progressive`, PreviewExtractors
construye el extractor MP4 fragmentado sin la lectura inicial MFRA al final del
archivo. La fábrica por defecto de Media3 activa ese flag incluso con flags cero;
se comprobó en el bytecode de la dependencia fijada. Leer el final de un spool
incompleto provocó timeout real en instrumentación. Para archivos completos se
conservan extractores e índice normales; el MP4 con índice inicial conserva seek.
El snapshot incluye `seekable` nativo y la UI desactiva seek cuando Media3 no lo
ofrece, aunque se conozca duración. No se inventa un seek map para fragmentos.


## S2j: búsqueda y guardado explícito de canciones

Primer vertical de descubrimiento: buscar canciones locales y de catálogo desde
Discover, resolver un recording sin identidad de audio y reproducirlo por el mismo
programa nativo. Guardar/retirar usa `/api/library/saved/set`, nunca adquisición
`/api/catalog/save`. La confirmación sólo llega desde el servidor; biblioteca
revalida saved y resuelve sus previews con el índice compartido. Álbumes/artistas
remotos, adquisición/importación y descubrimiento completo siguen en la matriz.

`lib/catalogTrack.ts` extrae la conversión pura que también usa el cliente web;
no importa stores/Web Audio. La pantalla nativa comparte SearchField/MusicListRowView,
identidades y builders Saved. Resolver mantiene keys de catálogo/proveedor y añade
el video id exacto. Una copia acquired se prefiere si el índice la reconoce.
La reproducción de búsqueda cambia explícitamente a una canción; no inventa fuentes
para resultados todavía sin resolver ni prepara toda la búsqueda por sorpresa.

Consulta debounce/cancelación, epoch de búsqueda y cuenta, acción más reciente y
AbortSignal impiden que una resolución antigua sustituya el programa. Un menú
captura consulta/cuenta/intención; deja de actuar tras cambio o teardown. Mutaciones
enviadas permanecen en su cuenta y refrescan sólo una superficie vigente. Offline
no busca ni prepara previews: se usa biblioteca Disponible sin conexión de S6a.
Errores, resultados vacíos, Retry y proveedores parciales usan textos compartidos.

Fixtures sustituyen proveedores externos y candidates del downloader, conservando
rutas reales, ranking/dedupe, matching/confianza/caché, permisos y Saved. Pruebas
cubren respuestas fuera de orden, cancelación de resolución, confirmación de
bookmark y retirada sin adquisición. El APK debe demostrar búsqueda → guardar →
Library → audio nativo, aislamiento al alternar cuentas y HTTP/HTTPS real. No
atribuir a fixtures validación del proveedor vivo ni escucha física.
