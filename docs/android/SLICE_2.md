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
son metadata nativa; carátulas en la notificación quedan pendientes.

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
