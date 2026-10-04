# Traspaso del port Android

## Leer antes de continuar

Este archivo es el punto de entrada para otro agente/contributor. No requiere
historial del chat ni memoria privada. Ver [guía](../ANDROID.md),
[arquitectura](ARCHITECTURE.md), [plan y paridad](PORT_PLAN.md),
[primer slice](SLICE_1.md), [offline](OFFLINE_DECISION.md) y
[publicación](RELEASE_GATES.md).

## Decisiones del usuario que siguen vigentes

- APK Android con UI Solid compartida y capa nativa; mantenerla desde el mismo repo.
- S0 fue la documentación y APK mínima. El usuario pidió después «push y a por
  el siguiente slice»: S0 se subió y S1 implementa conexión/biblioteca de lectura.
- Objetivo completo: teléfono, DJ, Live y Android Auto. No publicar una alpha
  parcial; los artifacts CI son de desarrollo y pueden ser accesibles públicamente.
- Offline B aprobado el 2026-10-03: música ya adquirida, copias explícitas,
  «Disponible sin conexión» en menús de tres puntos. Ningún botón de preparación
  en shells. Una biblioteca, espacio/progreso centralizados. Ver OFFLINE_DECISION.
- No hay teléfono Android propio. Separar emulador, dispositivos remotos y
  teléfono/coche reales; no llamar a CI aceptación acústica.
- Cada implementación termina con commit y push en rama, nunca main directo.
  Autorización vigente: continuar hasta paridad completa; después integrar todo
  por PR a main y cortar release con información/instrucciones de alpha.
  El usuario confirma mantener paridad completa antes de alpha (no alpha parcial).
  No delegar sin autorización.
- Respetar AGENTS: versión central, nada de `npm run build` local, suite completa
  de cuatro perfiles antes de abrir PR que toque `ui_web`, y base remota actual
  e impact label al abrir/integrar el PR autorizado tras completar la paridad.
- La app iOS es Swift independiente, no Solid sincronizado. Su runtime sigue
  sin validación de dispositivo. Mantener las advertencias sobre iOS/PAL.

## Estado actual de continuación

Los apartados de entrega siguientes son históricos; usar el último y PORT_PLAN
para saber qué falta. S2s conserva audio/ID al editar metadata/sidecar; S2t añade
bookmarks sobre entidades adquiridas y refresh confirmado. Los fallos encontrados
en regresión (refresh Saved y presupuesto auth compartido) están corregidos.
Última APK principal: **35 tests + dos fases offline persistentes pasan**, sources
preparados desde commit limpio cf01599; APK/test/lint normales pasan sin CA temporal.
Últimos browser completos tras S2z: Chromium 278/66 y WebKit 269/75, sin fallos,
sobre reparación de carrusel 78669b6. Repetir cuatro perfiles antes del PR final.
S2u selector OS y S2v prioridad de sidecar validados; S2w letras adquirido/preview
usa panel compartido con runtime nativo y pasa HTTP/HTTPS. Faltan biblioteca/
Discover/Settings completos, DJ, Live, Android Auto, firma y actualización.
S2x adquisición y S2y importación compartida/selector DocumentsUI HTTP/HTTPS
validados. S2z navegación Atrás validada con conservación de programa/sesión;
continuar sin cerrar por slice. La regresión principal de 45 casos y dos fases
offline está en curso con assets limpios 502947d; no sustituir el resultado
anterior hasta terminar. Próximo bloque: [eliminar adquirido](SLICE_2AA.md).
No PR/main/release todavía; mantener gates de alpha completa y continuar.

## Entrega S0

Rama: `feat/android-port-foundation`. Base inspeccionada:
`26be603c9712f5599507ca1fc7a43255040f1ce2`, 2026-10-02.
Para el commit final de S0 usar `git log --oneline --grep='Android port foundation'`;
no confundir el hash base con el commit de esta implementación.

Implementado: documentación y gates; proyecto Kotlin/Capacitor con fuentes y
Wrapper; assets Solid locales separados del bundle del motor; arranque compartido,
locale/preferencias/fuentes; información nativa real; helper prepare/build/install/
smoke; test instrumentado y workflow sin publicación. Los diccionarios Android
incluyen las cuatro lenguas existentes. Ninguna API del motor cambió.

No implementado **en S0**: servidor/cuenta/sockets, reproducción de ningún modo, descargas
locales, DJ, Live, servicio multimedia, Android Auto, firma permanente, actualizador
o publicación. El shell no importa esos runtimes ni solicita sus permisos.

## Validación de S0

Ejecución final local: 2026-10-02. La prueba actual del APK
lleva metadata `dirty=true` por haberse construido en el árbol de implementación;
no es un artifact limpio de un commit de release.

- Typecheck y Vitest: **1.320 tests / 137 archivos pasan**.
- Chromium móvil/desktop completo: **278 pasan / 66 omitidos por condiciones de plataforma**.
- WebKit móvil/desktop completo: **269 pasan / 75 omitidos por condiciones de plataforma**.
- APK debug + APK de tests + lint: **build correcto**, API 36/JDK 21.
- Emulador API 36, puente, arranque y reapertura sin conexión: **1 test instrumentado pasa**, incluida locale española y tema dark tras recrear actividad.
- Ruff check/format y versión central: correctos. Actionlint, diff y enlaces internos: correctos.

Problema encontrado y corregido: ejecutar tareas Gradle sin módulo intentaba
compilar también los tests de bibliotecas Cordova generadas y chocaba con sus
stdlib Kotlin antiguas. El helper apunta a `:app:*`, que prueba y empaqueta nuestra
app con sus dependencias. No se alteraron librerías en node_modules ni se añadió
un override global de Kotlin para taparlo.

[Resumen de evidencia S0](evidence/s0.json) y
[captura de arranque](evidence/startup-api36.png): la captura standalone usa los
defaults English/system-light; el test instrumentado demuestra español/dark.
El fallo inicial de reapertura fue una carrera del test, que consultaba el DOM
antiguo antes de iniciarse la navegación. Recrear la actividad y esperar su nueva
WebView verifica el arranque real.

Resultados reproducibles quedan en `android/app/build/reports/`,
`android/app/build/outputs/androidTest-results/` y artifacts CI futuros. Toolchain
local temporal: `/home/arsu/.cache/soundsible/android-toolchain`; **no depender de
esa ruta en otras máquinas**. Exportar SDK/JDK como en ANDROID.md. El entorno CI de S0
se definió, pero entonces no se había ejecutado en GitHub. El push a una rama
feature no dispara el workflow filtrado a main/dev; no presentar CI como verificado.

## Entrega S1 y evidencia actual

Rama `feat/android-port-foundation`. S0 subido como `3c9ff98`.
Para el commit de S1: `git log --oneline --grep='native account transport'`.

Implementado: origen validado, login de cuenta y passwordless, cookie cifrada en
Keystore, REST/multipart/abort/ETags, carátulas privadas sin cache entre cuentas,
Socket.IO por identidad, logout/cambio/revocación, refresh manual/foreground,
biblioteca de lectura y colecciones usando la fila visual Solid compartida.
No se modifican CORS ni auth del motor; no se importa runtime de reproducción.
HTTP público sigue bloqueado por Android; alias nativo reservado para IP privada,
Host preservado y DNS verificado. Ver decisión técnica en ARCHITECTURE.

Prueba real reproducible: `python scripts/android.py build` y, con Python del
motor y AVD arrancado, `python scripts/android.py integration`. El helper crea
tres motores en directorios nuevos y los apaga. No apuntar fixtures al engine
personal. `android/build/fixture.log` y reportes Gradle conservan evidencia local;
la metadata de las comprobaciones previas al commit dice `dirty=true`.

Resultados finales/evidencia: [S1](evidence/s1.json) y [captura](evidence/library-api36.png).
Typecheck/Vitest: 1.330 tests en 141 archivos; contratos backend: 43 pasan;
APK/lint e integración API 36: 5 tests pasan, incluida WebView con cover real.
Suite browser completa: Chromium 278 pasan/66 omitidos; WebKit 269 pasan/75
omitidos en la repetición final. Una ejecución anterior tuvo un fallo de scroll
en Descubrir; pasó tres veces aislado y después en la suite completa sin cambios
de fuentes. La evidencia conserva ambos resultados.
 No confundir las dos primeras
pruebas fallidas (red del AVD desactivada / lectura de generation como Long) con
el resultado corregido. La política de HTTP privado se comprueba también a nivel
Android: example.com no permite cleartext. El cliente de control del fixture usa
el mismo routing privado pero no adjunta cookie; un OkHttp genérico correctamente
queda bloqueado por la política OS.

HTTPS positivo ya se prueba con motor real y CA efímera/hostname verificado,
además del rechazo de HTTP anunciado como HTTPS. La CA de pruebas se elimina y
el APK normal se reconstruye sin ella. No hay clave privada o confianza de prueba
commiteada. Aceptación de despliegue todavía abierta: instancia HTTPS pública
concreta, DNS LAN/Tailscale reales y teléfono. La biblioteca todavía no ofrece todas las
acciones web ni podcasts/descubrimiento; no marcar paridad completa.


## Entrega S2a: primer programa nativo

El usuario pidió continuar después del push de S1 (`d0cb3a3`). S2a implementa
el primer corte de [S2](SLICE_2.md), no S2 completo. Localizar el commit con
`git log --oneline --grep='native NORMAL program'`. Push autorizado en esta rama;
no abrir PR ni publicar por completar este corte.

Implementado: servicio MediaLibraryService/ExoPlayer, MediaSession/MediaController,
streaming de archivos autenticado con cookie nativa y Range, foco/noisy/foreground,
cola básica con ocurrencias, Play/Pause/seek/Previous/Next y snapshots de
metadata/posición/error. Solid usa las filas compartidas y controles temporales;
no importa AudioService/Web Audio ni inventa éxito síncrono. Activo sólo para
archivos; previews guardados siguen visibles/desactivados.

La conexión es ahora del proceso (`EngineConnection.shared`). Destruir Activity
libera controlador/socket y cancela sus REST por namespace único; no destruye el
programa. Background suspende el ticker de JS. Logout/cambio/401 antes de otro
login borran sesión, avanzan generación y cancelan audio; fuentes antiguas no
pueden adoptar una cookie nueva. URI de época sólo interna y retirada del HTTP.
La cola actual no se persiste tras process death. Sólo el UID propio reemplaza
cola; clientes OS externos deben ser trusted. Sin catálogo de Android Auto aún.

Pruebas/captura: [S2a](evidence/s2a.json) y [programa](evidence/program-api36.png).
Typecheck/Vitest: 1.331 tests / 142 archivos. Contratos backend auth/socket/Range:
49 pasan. APK/lint e integración API 36: 7 tests pasan, incluida notificación
multimedia/token de sesión, Range, foco y revocación. Reapertura sin red: 1 pasa
y 6 fixtures se omiten. Chromium completo: 278 pasan/66 omitidos; WebKit completo:
269 pasan/75 omitidos. Un fallo inicial de scroll en artista pasó tres veces
aislado y luego en la suite completa sin cambios de fuentes; evidencia conserva
ambas ejecuciones. La selección de segunda ocurrencia se verifica tocando la
fila de una playlist real, además de comandos nativos.

Los fixtures añaden WAV sintéticos, auditoría de Range sin cookies y controles
sólo locales de fallo/revocación. Se salta al final de un tono generado de 600 s
para obligar a Media3 a leer un rango nuevo; un fichero de 60 s se precargaba
entero y el seek no necesitaba HTTP. No usar música personal ni cambiar el motor
para que una prueba inventada obtenga Range. Otra corrección: onConnect devolvía
comandos vacíos, así que se conceden explícitamente con la restricción de cola.
El test de arranque selecciona el heading de la pantalla, no el loader retenido.

Limitaciones materiales: UI temporal, límite de 1.000 archivos, sin artwork en
notificación, sin resumption tras process death ni previews/podcasts/radio.
MediaLibrarySession no demuestra Auto; token/media commands en emulador no
validan pantalla bloqueada, Bluetooth, desconexión/llamadas o escucha en teléfono.
Gates de servidor HTTPS público/DNS/Tailscale y coche siguen abiertos. Offline
continúa sin decisión y no se implementa aquí. No alpha.

## Siguiente tarea concreta

Continuar según el último corte propuesto al final de este archivo. S2e y S2f
ya cubren inserción de biblioteca y recuperación explícita del programa local. Ver la propuesta al final de este traspaso y [S2](SLICE_2.md).
Después adaptar rutas/acciones completas antes de montar AuthenticatedPlayer o
retirar LibraryBrowser. Fuentes previews/podcasts/resume/±15s/radio, artwork y
aceptación phone/Auto mantienen sus gates. No introducir un segundo dueño Web Audio.

Antes de trabajar: `git status --short --branch`, leer AGENTS y verificar archivos
actuales. Actualizar este traspaso con cada slice: commit, pruebas/evidencias,
capacidad pendiente y próximo paso. No arrastrar resultados antiguos como actuales.

## Entrega S2b: modos de la cola nativa

Continuación de S2a en la misma rama: comandos asíncronos `shuffle`/`repeat` y
snapshots con modos y disponibilidad de siguiente/anterior según Media3. Mantiene
índices de ocurrencias originales; conserva modos en background/recreación y los
restablece al reset de cuenta/origen. Parámetros obligatorios y modos inválidos
se rechazan sin mutación. Ver [contrato S2b](SLICE_2.md#s2b-modos-nativos-de-cola).

Este corte modifica sólo Kotlin/tests Android y documentación. No añade botones
ni el tipado de estos campos a Solid; eso queda junto a la integración asíncrona
con el runtime autenticado, que sigue siendo el próximo slice prioritario. No
marca NORMAL completo, S2 completo ni alpha lista. No se vuelve a ejecutar la
suite browser por este corte sin cambios en `ui_web`.

Validación local: APK en API 36, **7 tests instrumentados pasan / 0 omitidos**, con
programa HTTP y HTTPS verificado, modos mediante puente real, modos conservados
tras recreación/background, rechazo de repeat inválido, vuelta a secuencial y
limpieza de ambos modos al logout. Se mantienen las pruebas S1 y S2a. El helper
reconstruye el APK normal sin CA de fixture y ejecuta lint. Evidencia específica:
[evidence/s2b.json](evidence/s2b.json). Emulador no prueba aceptación acústica,
Bluetooth o coche. No se ha ejecutado el workflow GitHub ni publicado release.

El usuario pidió subir todo trabajo pendiente: se subieron las ramas locales de
auditoría y corrección de seek iOS, además de esta línea Android. Cambios sin
commit del worktree de fiabilidad se conservaron en
`wip/reliability-worktree-backup`: respaldo **sin validar para integrar**, creado
sin alterar su working tree/índice y excluyendo su enlace local `.venv`.

## Entrega S2c: observación asíncrona y controles Solid

El programa tiene ahora un contrato tipado independiente de Capacitor/Solid/Web
Audio en `ui_web/src/lib/program/runtime.ts`. AndroidStart usa ese runtime y el
componente `ProgramTransport` en vez de sus comandos/listener/JSX incrustados.
Shuffle/repeat pasan a estar disponibles en la UI de desarrollo. Las respuestas
se ordenan por generación y secuencia nativa; los comandos se serializan y los
callbacks pendientes se descartan al desvincular una cuenta. Un Play aceptado no
se convierte en estado playing por lógica JS. La limpieza de UI no para el servicio.

El runtime es la primera parte de la integración compartida. **No está montado
AuthenticatedPlayer, no se ha retirado LibraryBrowser, y el navegador no usa este
nuevo runtime todavía**. Mantener estas limitaciones al informar de paridad. El
contrato síncrono de AudioService sigue siendo de mezcla y no debe suplantarse.
El siguiente corte debe adaptar acciones/estado de cola y rutas NORMAL a este
contrato, con selección por ocurrencias y operaciones asíncronas; después ampliar
fuentes/artwork según SLICE_2. No introducir AudioContext/HTMLAudio en Android.

Los tests específicos prueban comandos en orden, respuesta inicial/command tardía
frente a eventos nuevos, errores de otra cuenta ignorados, comandos en espera
invalidados, listener tardío liberado, reintento después de fallo y seek arrastrado
estable con ticks. La prueba instrumentada toca Shuffle y selecciona Repeat en
el Solid real antes de comprobar Media3, background y recreación.

Advertencia práctica para la continuación: `integration` ejecuta Gradle sobre los
assets preparados; tras cambiar Solid, ejecutar `scripts/android.py build` antes.
La primera ejecución S2c omitió ese paso y falló con los controles de S2b todavía
empaquetados. La guía ya muestra ambos comandos y la evidencia conserva el fallo.

### Siguiente corte propuesto: S2d, cola NORMAL por ocurrencias

Mostrar el programa actual desde el snapshot nativo (incluyendo metadatos de cada
entrada), permitir seleccionar/mover/quitar una ocurrencia por índice y conservar
posición/modos al editar otra fila. Ampliar la unión de comandos del runtime,
validar generación/límites en Kotlin y observar el resultado; no reconstruir toda
la cola desde la biblioteca para cada acción. Reutilizar la presentación de filas
compartida sin importar adaptadores que arrastren `stores`/Web Audio; auditar
`PlayerTrackList`/`MusicLinks`/`MusicListRow` antes de montarlos directamente.

Aceptación: dos filas con el mismo id son distinguibles en selección/eliminación,
mover otra fila no reinicia la canción actual, quitar la actual tiene transición
explícita y la última fila vacía el programa; conservar modos, controles OS y
recreación, rechazar edición tardía de otra cuenta. Probar mediante UI empaquetada
y fixtures HTTP/HTTPS, además de contratos y cuatro perfiles browser. Este corte
no resuelve previews/podcasts/radio ni sustituye por sí solo toda la biblioteca;
reduce otro bloque concreto antes de montar las rutas completas.

### Validación final de S2c

Typecheck/Vitest: **1.339 tests / 144 archivos**. APK debug/test y lint correctos;
integración API 36 **7 pasan / 0 omitidos / 0 fallos**, incluidos controles Solid
reales con HTTP/HTTPS y loader retirado antes de captura. Chromium completo:
**278 pasan / 66 omitidos**. WebKit completo, readonly/1 worker después de Chromium
y sin emulador: **269 pasan / 75 omitidos / 0 fallos**. Sin cambios de fuentes
compartidas durante las suites. Versión central, firma APK, ausencia de CA de
fixture/Web Audio en artifact, diff y enlaces internos verificados. No se vuelven
a atribuir los 49 tests backend de S2a a este corte sin cambios backend.

[Evidencia S2c](evidence/s2c.json) y [captura visible](evidence/program-s2c-api36.png).
La evidencia conserva metadata de la validación con dirty=true; no es una release.
Para identificar el commit final: `git log --oneline --grep='asynchronous program runtime'`.

## Entrega S2d: cola NORMAL por ocurrencias

La UI de desarrollo observa metadata de todas las entradas del servicio, muestra
su orden y permite seleccionar/mover/quitar una aparición concreta. Un UUID
nativo por entrada y la huella del orden impiden confundir duplicados o ejecutar
una edición atrasada. La validación ocurre en PlaybackService por comando custom
privado al UID de la app, antes de editar ExoPlayer; no se reemplaza toda la cola.
Ver [contrato S2d](SLICE_2.md#s2d-cola-normal-por-ocurrencias).

Seleccionar pide inicio/Play. Mover/quitar otra entrada conserva posición y pausa;
quitar la actual sigue semántica de Media3, y la última vacía y detiene. Los modos
se mantienen, incluso con cola vacía, hasta reset de cuenta/origen. Metadata/keys
siguen en el servicio al recrear Activity. No hay persistencia de queue/keys.
ProgramQueue reutiliza la fila pura compartida, virtualiza y mide altura real de
filas con controles visibles; no importa los adaptadores con stores/audio.

Fallos iniciales corregidos: mock de ResizeObserver faltante en jsdom; foco perdido
al mover un nodo DOM (aunque conservase identidad); constantes de error antiguas
rechazadas por lint de Media3. La primera integración funcional pasó pero la
captura mostró filas solapadas en edición: el estimado fijo no medía su crecimiento.
Se separaron controles de la fila compartida y se mide cada elemento; la prueba
instrumentada ahora comprueba rectángulos sin solapamiento. Chromium se interrumpió
para esta corrección y su ejecución completa se repite con fuentes congeladas.

### Siguiente corte propuesto: S2e, acciones de biblioteca hacia NORMAL

Añadir después y añadir al final desde las filas de biblioteca/colecciones, con
comandos nativos de inserción que crean UUIDs y fuentes desde ids/metadatos (sin
URI/cookie de JS). Mantener la canción, posición, pausa/modos y claves existentes;
validar generación, orden esperado y límite de cola en el servicio. Reutilizar
menús/presentación compartidos mediante callbacks sin importar stores de mezcla.
Probar nuevas ocurrencias de un id repetido, inserción después de la actual, cola
vacía, límites y rechazo de acción antigua, más recreación/controles OS.

S2e seguirá con archivos locales: la adquisición y el transporte real de previews
necesitan un corte posterior específico. No dar por resueltos edición completa,
rutas AuthenticatedPlayer, podcasts/radio/artwork/DJ/Live/Auto/offline.

### Validación final de S2d

Typecheck/Vitest: **1.344 tests / 145 archivos**. APK debug/test y lint correctos;
integración API 36 **7 pasan / 0 omitidos / 0 fallos**, HTTP y HTTPS verificado,
ediciones reales desde Solid, fingerprint/key/generación incorrectos rechazados
y rectángulos sin solapamientos. La captura espera fila actual/panel en viewport
y dos frames después del scroll instantáneo. Chromium completo: **278 pasan /
66 omitidos**; WebKit completo readonly/1 worker: **269 pasan / 75 omitidos /
0 fallos**, después de Chromium y sin emulador.

Durante el Chromium final se ajustó sólo ProgramTransport, importado por Android
y tests (no por el grafo web): no hubo HMR ni page reload. Se repitieron unit/APK
con ese cambio. WebKit se ejecutó después, con todas las fuentes congeladas.
Versión central, firma APK, ausencia de CA fixture/Web Audio, diff y enlaces
verificados. No se atribuyen aquí tests backend antiguos ni CI GitHub no ejecutado.

[Evidencia S2d](evidence/s2d.json) y [cola visible](evidence/queue-s2d-api36.png).
Metadata de validación conserva dirty=true; no es una release. Commit final:
`git log --oneline --grep='edit NORMAL queue by native occurrence'`.

### Entrega S2e

Añadir después de la actual/al final desde filas locales de biblioteca y
colecciones. Usa menús/outlets compartidos y comandos asíncronos hacia el único
player nativo. No importa stores de mezcla. Factoría de fuentes nativa compartida
con reemplazo de cola, UUID nuevo por entrada; JS sólo proporciona metadatos.
Guards de generación/orden y, para insertAfter, ocurrencia actualmente seleccionada.
Lote y capacidad total se validan antes de mutar. Una cola vacía queda preparada en
pausa. En shuffle «después» es posición visible, no promesa de próximo audio.
Detalles: [S2e](SLICE_2.md#s2e-añadir-desde-biblioteca-y-colecciones).

### Validación final de S2e

Typecheck/Vitest: **1.348 tests / 146 archivos**. APK debug/test y lint correctos;
integración API 36 **7 pasan / 0 omitidos / 0 fallos** con HTTP/HTTPS verificado.
Chromium completo: **278 pasan / 66 omitidos**. WebKit completo readonly/1 worker:
**269 pasan / 75 omitidos / 0 fallos**, después de Chromium y con emulador detenido.
Sin cambios en fuentes del grafo web durante ambas suites. Firma APK, versión
central, ausencia de CA fixture/Web Audio, diff y enlaces locales verificados.

El HTTP instrumentado falló inicialmente por seleccionar «primera fila»: el test
de sockets había añadido una entrada de catálogo sin WAV real. La espera de READY
reveló el error de fuente. Ahora el test abre el menú de la canción fixture por su
label y espera audio preparado antes del seek. HTTPS pasó esos intentos; ambos
pasan al final. No se ocultó el fallo ni se retiró la prueba de posición.

[Evidencia S2e](evidence/s2e.json) y [menú en viewport](evidence/menu-s2e-api36.png).
La captura usa sólo cuenta/datos sintéticos del fixture TLS. Metadata de validación
conserva dirty=true y base anterior; no es una release. El APK limpio posterior al
commit debe usar ese nuevo HEAD y dirty=false. Commit: `git log --oneline
--grep='insert library tracks into native NORMAL queue'`. No CI GitHub, PR/merge ni
aceptación acústica de dispositivo se atribuyen a estos checks locales.

### Siguiente corte propuesto: S2f, recuperación de conexión del programa NORMAL

Antes de adquisición/previews y de retirar LibraryBrowser, definir y probar la
recuperación del programa local al perder/restaurar el servidor. Conservar cola,
ocurrencias, posición y pausa; mostrar estado recuperable y reintento explícito sin
relogin artificial ni reproducción duplicada. Diferenciar red, 401 y 403; logout
sigue vaciando antes de otra cuenta. Probar corte real de stream/red, recuperación
HTTP/HTTPS y recreación mientras está desconectado, sin convertirlo en offline ni
caché de audio. Auditar primero el comportamiento actual de Media3 y del datasource;
no añadir retry automático ilimitado ni saltar certificados. Adquisición/preview,
rutas completas, podcasts/radio/artwork/DJ/Live/Android Auto y offline siguen aparte.

### Entrega S2f: recuperación explícita del programa

El snapshot separa playing de intención playWhenReady y clasifica errores nativos.
Retry sólo para conexión/servidor, con generación/huella/key/index validados contra
el error y la ocurrencia actuales del servicio; prepare conserva la cola y la
intención más reciente. Pause funciona durante buffering/fallo. No hay retry de
audio en background (política Media3 explícita y retry transparente de OkHttp
inactivo). Certificados/handshake, fuente, 401 y 403 no reciben ese Retry.

La Activity muestra el programa del servicio aunque no pueda revalidar identidad;
el arranque local no espera una petición remota. Refresh usa la cookie nativa sin
reconfigurar ni sustituir el programa. Un 401 limpia también si aún no hay identidad
resuelta; un 403 muestra permiso y permite revalidar con Refresh. Logout/cambio
siguen disponibles y limpian antes de otra cuenta. No se persiste una biblioteca ni
audio. Se usa la composición connected si existe programa, para mantener ancho útil
de la cola al fallar la identidad. [Contrato S2f](SLICE_2.md#s2f-recuperación-explícita-de-conexión).

Pruebas instrumentadas: lectura WAV realmente truncada tras headers, HTTP/HTTPS
verificado, conservación de claves/índice/posición/pausa/modos, ausencia de nuevas
peticiones de audio tras error, recreación con API 503, revalidación 403 sin logout,
Retry con intención Play conservada y stream 401 que limpia sin identidad resuelta.
Para lectura truncada no usar ConnectionResetError en el generator del fixture:
el middleware del motor lo suprime como desconexión del cliente y deja una respuesta
incompleta esperando timeout. RuntimeError posterior a headers cierra el cuerpo.

Fallos corregidos durante validación: test viejo asumía que label Pause implicaba
isPlaying; ahora puede cancelar intención en buffering, así que se espera estado
nativo antes de seek. La primera captura mostraba cola estrecha con composición
start al perder identidad; se usa connected y se exige ancho igual al área útil.
La aserción inicial olvidaba la barra de scroll: ahora usa clientWidth y padding
reales, con tolerancia de un píxel, además del Retry dentro de viewport. WebKit
parcial se interrumpió para esta revisión; sólo su repetición completa cuenta.

### Validación final de S2f

Typecheck/Vitest: **1.350 tests / 146 archivos**. APK debug/test y lint correctos;
integración API 36 **7 pasan / 0 omitidos / 0 fallos** con fixtures HTTP y HTTPS
verificado, incluyendo lectura truncada real, intención Play/pausa, 401/403 antes
de resolver identidad y medición del ancho útil. Captura final revisada.
Chromium completo: **278 pasan / 66 omitidos**; WebKit completo readonly/1 worker:
**269 pasan / 75 omitidos / 0 fallos**, después de Chromium y del trabajo APK/unit,
con emulador detenido y fuentes congeladas. Durante/después de Chromium no cambió
su grafo web ni hubo HMR/page reload; los cambios posteriores fueron AndroidStart
(sólo entrada nativa), fixtures/tests y Kotlin. WebKit parcial no cuenta.

Versión central, firma APK, ausencia de CA fixture/Web Audio, Ruff del fixture,
diff y enlaces locales verificados. [Evidencia S2f](evidence/s2f.json) y
[captura de recuperación](evidence/recovery-s2f-api36.png), sólo datos sintéticos.
Metadata de validación conserva dirty=true/base previa; el build limpio posterior
al commit usa ese HEAD y dirty=false. Commit: `git log --oneline
--grep='recover native program after connection loss'`. No se atribuyen checks
backend de otros slices, CI GitHub ni aceptación física. No release/alpha.

### Siguiente corte propuesto: S2g, carátulas del programa y notificación

Completar metadata/artwork de las ocurrencias nativas y de la sesión multimedia,
reutilizando carátulas del motor. Crear la fuente de imagen desde id en nativo;
no enviar cookies/URI de engine desde JS ni usar un fetch público para imagen privada.
Validar generación/origen, límites de bytes/decodificación/tiempo y cancelación;
evitar que respuestas tardías o caché muestren una cuenta anterior. Placeholder
cuando falte cover o falle servidor; un fallo de artwork no corta audio ni exige
login por un 404 de imagen. Probar imágenes HTTP/HTTPS reales, duplicados/cambio de
ocurrencia, Activity recreation, logout/cambio de cuenta, imagen ausente/inválida y
notificación/MediaSession en el emulador. Auditar primero DefaultMediaNotificationProvider
/BitmapLoader y APIs exactas de la versión fijada. No presentar notificación como
catálogo Android Auto ni aceptación física. UI/rutas completas, adquisición/previews,
podcasts/radio/DJ/Live, muerte de proceso y decisión offline siguen pendientes.


### Entrega S2g: carátulas privadas del programa y notificación

`ProgramQueue` crea artworkUri desde id/generación. `ProgramArtwork` es el BitmapLoader
nativo de MediaLibrarySession: cookie/origen privados, HTTP privado/HTTPS verificado,
sin redirects ni fallback público. Dos workers/16 trabajos en espera; 8 segundos,
2 MiB, inspección de dimensiones hasta 16 megapíxeles y muestreo a 512 px. Retiene
sólo el último future en memoria; reset cancela HTTP/futures y descarta el resultado.
Los errores no borran sesión ni cambian el player. La URI/bytes/cookie no vuelven a JS.
La UI de programa/cola reutiliza covers/gradientes y proxy privado de S1, ahora con
límite de cuerpo y revalidación de generación durante lectura/antes de respuesta.
[Contrato S2g](SLICE_2.md#s2g-carátulas-privadas-del-programa-y-sesión).

La instrumentación verifica el bitmap de la sesión Android y large icon de la
notificación con carátula privada real, además de HTTP/HTTPS, duplicados, Activity,
foco y los casos de recuperación existentes. Un cargador de imagen separado falla
con el audio activo sin cambiar índice/playing/error ni borrar cookie. Imágenes de
otra cuenta nunca muestran su color privado; se acepta placeholder del motor o
rechazo. Se prueban 404, bytes inválidos, cuerpo excesivo y logout durante respuesta
lenta, seguido de login de otra cuenta. No hay prueba física de lockscreen/Bluetooth,
ni catálogo Android Auto. La imagen correcta de metadata/notification no demuestra
sonido acústico.

El primer run falló en cuatro assertions por exigir RGB exacto al PNG sintético:
el motor genera thumb JPEG, con diferencias de un punto por canal. Se corrigió la
assertion para tolerar hasta tres puntos, manteniendo discriminación de cuentas.
También se ajustó la expectativa de imagen ajena: el endpoint puede responder con
placeholder, no necesariamente 404. La revisión final amplió la prueba de privacidad
a canales con la misma tolerancia y liberó referencias de trabajos cancelados.

### Validación final de S2g

Typecheck/Vitest: **1.350 tests / 146 archivos**, sin fallos. APK/test APK/lint e
integración API 36: **9 tests, cero fallos/errores/omitidos**, HTTP y HTTPS verificado
con casos S1/passwordless anteriores conservados. Chromium completo: **278 pasan /
66 omitidos**; WebKit completo: **269 pasan / 75 omitidos**, sin fallos. Fuentes UI
congeladas antes de unit/Chromium y preparación APK; cambios posteriores sólo nativo,
instrumentación y documentación. WebKit fue después de todo trabajo nativo y Chromium,
con emulador detenido, mount de sólo lectura y un worker. No se ejecutó GitHub CI.

Ruff/check/format, sincronización de versión central, diff y enlaces locales pasan.
APK normal firmado, sin CA/recursos de fixture; JS nativo sigue sin AudioContext ni
runtime de mezcla. [Evidencia S2g](evidence/s2g.json) y
[captura de cola](evidence/queue-artwork-s2g-api36.png) con datos sintéticos. El JSON
registra el build de validación dirty sobre el commit anterior; el APK normal se
regenera limpio después del commit de este corte. Ningún artifact es una release.

### Siguiente corte propuesto: S2h, cierre explícito del programa nativo

Punto de partida: `PlaybackPlugin.command("stop")` hace stop/clear desde el controller
y resuelve un snapshot inmediato; aún no resetea playWhenReady/modos ni confirma la
mutación mediante el custom command del servicio. `ProgramArtwork` retiene el último
resultado hasta reset/destroy. Añadir una acción visible para cerrar el programa,
con confirmación asíncrona del servicio y limpieza del cargador sin cambiar cuenta. Vaciar fuentes/ocurrencias,
resetear intención/modos, retirar metadata/carátula/notificación y liberar recursos
sin borrar login ni biblioteca. Debe funcionar aun con API inaccesible y no dejar
una cola que reaparezca al recrear Activity; una activación posterior crea otro
programa con nuevas keys, sin autoplay procedente de intención vieja.

Revisar APIs fijadas de Media3 para estado vacío/foreground/notificación, y la
semántica de retirar tarea de recientes frente a cerrar programa. Probar UI +
MediaController + notificación con Play, pausa, buffering/error, servidor 503,
recreación y nueva reproducción, sin introducir persistencia/process death ni
suponer un comportamiento no probado de swipe en teléfono. Mantener foco/ruido
con sus límites de aceptación física documentados. Este corte sigue siendo de
desarrollo: rutas completas, adquisición/previews, podcasts/radio, DJ/Live,
Android Auto y decisión offline permanecen pendientes.


### Entrega S2h: cierre explícito del programa

× en la cabecera Solid, con aria-label localizado y 44 × 44 px, envía stop con
queueToken/generación. El custom command del servicio valida UID propio y cola;
no requiere REST ni cookie para cerrar. Pausa, vacía fuentes/ocurrencias, resetea
modos/intención/error y cancela audio/artwork; el plugin espera ver el estado vacío
por IPC antes de resolver. No se cambia identidad, sesión o biblioteca. Snapshot
vacío usa index -1 y metadata/progreso cero. Media3 retira notificación por timeline
vacío; se conserva sesión/player mientras estén enlazados controllers.
[Contrato S2h](SLICE_2.md#s2h-cierre-explícito-del-programa).

Se inspeccionaron las APIs/JAR fijados de MediaSessionService,
MediaNotificationManager y ExoPlayerImpl. Stop retiene un error previo: tras vaciar,
prepare sin fuentes y otro stop limpian ese error sin red ni autoplay. El bitmap
loader tiene clear independiente de cuenta para cancelar trabajos y descartar su
último resultado. El cliente audio se cancela y expulsa conexiones idle. La
conexión de cuenta y lectura de biblioteca siguen independientes del programa.

Cierre instrumentado desde Play, pausa, headers de audio retrasados y error 503,
con API devolviendo 503 en cada caso. Cola/UI/notificación y metadata/artwork Android
quedan vacías; cookie/generación no cambian. Activity recreation no reconstruye la
cola. Una huella obsoleta se rechaza. Append posterior crea nuevas keys, permanece
pausado y usa modos por defecto; una activación explícita de biblioteca reproduce
otra vez. Respuestas de audio retrasadas no resucitan el programa.

Recientes no equivale a cerrar programa. No se modifica onTaskRemoved: en la versión
fijada exige foreground e isPlaying para conservarlo; si no, llama a
pauseAllPlayersAndStopSelf. El caso finishAndRemoveTask/reapertura en API 36 conserva
playing/key y luego permite cerrar, con un controller de instrumentación enlazado.
No es prueba física de swipe/lockscreen/auriculares/Bluetooth, ni process death o
política de fabricantes. No se implementó persistencia/offline ni publicación.

Los fallos iniciales se resolvieron sin eliminar aceptación: el helper de arranque
sin servidor no era válido para recreación configurada; stop realmente retenía
error y se corrigió; la captura a 320 px mostró título estrechado por los controles,
y se separó la cabecera. Después la prueba de recovery S2f dependía de modos heredados
de stop: ahora configura shuffle/repeat antes de interrumpir, manteniendo sus
assertions de conservación. Las suites completas se repiten tras el cambio UI final.

### Validación final de S2h

Typecheck/Vitest: **1.351 tests / 146 archivos**, cero fallos. APK/test APK/lint e
integración API 36: **11 tests, cero fallos/errores/omitidos**, HTTP/HTTPS verificado
y casos S1/passwordless conservados. Chromium completo: **278 pasan / 66 omitidos**;
Primera suite WebKit S2h: **268 pasan / 75 omitidos / 1 fallo** en menú de cola móvil.
El caso pasó tres veces aislado sin cambios de fuentes/assertions; la repetición
completa final pasó **269 / 75 omitidos / cero fallos**. No se confirmó causa del
timeout inicial; la evidencia lo conserva y no lo presenta como un bug corregido.
El recuento verde se había escrito antes de verificar el primer resumen y se
corrigió antes del push. Las suites finales unit y
Chromium se ejecutaron después de corregir la cabecera; cambios posteriores sólo
instrumentación/documentación. WebKit se ejecutó tras todo trabajo nativo y Chromium,
con fuentes UI congeladas, emulador parado, mount de sólo lectura y un worker.
No se ejecutó CI GitHub ni aceptación acústica/física.

Ruff/check/format, versión central, diff, enlaces locales y firma APK pasan. APK
normal sin CA/recursos de fixture; bundle nativo sin AudioContext/runtime de mezcla.
[Evidencia S2h](evidence/s2h.json), [cabecera/cierre](evidence/close-open-s2h-api36.png)
y [cerrado con API inaccesible](evidence/close-unreachable-s2h-api36.png), todo sintético.
El JSON registra el build dirty sobre el commit anterior; después de commit se
regenera el APK normal limpio con su source_revision. No release/alpha.

### Propuesta de S2i (implementada a continuación)

Primer vertical para canciones guardadas que hoy se muestran pero no se reproducen.
Auditar primero las fuentes/ids reales de Track/source=preview y el contrato actual
`/api/preview/stream/<video_id>`, prefetch/status/cancel y progressive-preview del motor.
Introducir un discriminante de fuente en ProgramTrack/metadata nativa, conservando
UUID de ocurrencias y seleccionando por índice incluso con local/preview mezclados.
Nativo construye la fuente desde id validado; no recibe URL/CDN/cookie de JS, y no
usa stream-url para enviar la sesión del motor a un proveedor externo.

Reutilizar preparación/errores/transiciones actuales del motor: cancelación por
cola/generación/cierre, preparación pendiente real sin fingir playing, progreso y
Range sobre proxy, 401/403/429/503 y Retry acotado sin reemplazar programa. Retirar
la desactivación de preview sólo para el flujo realmente validado. Mantener
carátulas seguras/placeholder y no ampliar adquisición, podcasts/radio o DJ por
suposición. Probar ruta real del motor con proveedor sintético aislado, cache de
motor completa/progresiva, duplicates/mezcla, Activity/background/cierre y HTTP/
HTTPS verificado. Fixtures no prueban proveedor vivo ni escucha física. Ningún
cache temporal del motor supone offline Android aprobado; la decisión sigue abierta.


### Entrega S2i: previews guardados en el programa nativo

La biblioteca permite reproducir canciones guardadas con source preview y mezclar
locales/previews sin perder índice ni UUID de ocurrencia. El descriptor compartido
sólo admite metadata e id; el servicio construye el proxy del motor y conserva
cookie/origen/TLS en nativo. No solicita stream-url ni envía credenciales al
proveedor. Programa, cola y metadata Android usan placeholder para preview.
[Contrato S2i](SLICE_2.md#s2i-previews-guardados-por-el-proxy-del-motor).

El servicio observa preparación real del preview actual con una petición en vuelo,
extras asociados a generación/UUID y estado playing exclusivamente de Media3.
Detiene sondeo al llegar ready/unavailable, error, cambio o cierre; cold sólo se
sondea mientras el player sigue buffering. Cancelar retira únicamente lectores y
esperas propios. Audio registra cuerpos abiertos hasta callEnd/callFailed; Activity
recreation no cancela el programa. Seek refleja isCurrentMediaItemSeekable.

429/503 permiten dos retries iniciados dentro de treinta segundos del primer
fallo, respetando Retry-After y conservando intención de pausa y cola. Agotado el
presupuesto aparece Retry explícito, deshabilitado durante cooldown. Play pasa por
el custom command del servicio con índice/UUID/token/generación; las guardas de
Prepare/Play y selección de la misma ocurrencia también impiden saltar cooldown.
Los archivos locales conservan la política previa.

La instrumentación usa rutas/cache/Range reales del motor y un proveedor localhost
con MP4 AAC indexado, MP4 fragmentado y WebM Opus sintéticos. Se corrigió una lectura
MFRA inicial al final del spool progresivo que bloqueaba el extractor fragmentado:
sólo las respuestas progressive usan ese extractor sin lectura de cola; archivos
completos conservan el índice normal. También se corrigió Play que inicialmente
preparaba antes de validar cooldown. Ambas regresiones quedan cubiertas. Los
ajustes de helpers de arranque/recreación y UUID y la espera de commit de cache
conservan las assertions: EOF del lector no significa commit terminado.

### Validación S2i

Typecheck/Vitest: 1.355 tests, 146 archivos. Retry nativo: dos tests unitarios.
Python: 57 tests de rutas/cache/fixture, incluido motor real y lectores compartidos.
APK/test APK/lint e integración API 36: 13 tests, cero fallos/errores/omitidos,
con HTTP, HTTPS verificado y passwordless. Fuentes congeladas en la pasada final.
Chromium completo: 278 pasan / 66 omitidos. WebKit completo: 269 pasan / 75
omitidos. Cero fallos; ejecución secuencial, emulador parado, WebKit con mount
de sólo lectura y un worker. [Evidencia S2i](evidence/s2i.json).
La integración elimina su CA temporal y reconstruye el APK normal al terminar.
Tras commit se vuelve a generar desde HEAD limpio y se verifica source_revision;
el JSON de evidencia registra el build de instrumentación sobre el commit anterior.
No CI GitHub, proveedor vivo ni aceptación acústica/física ejecutados.

### Siguiente corte propuesto: S2j, búsqueda y guardado explícito de canciones

Auditar el contrato real de búsqueda/adquisición y Library antes de ampliar UI.
Primer vertical acotado: buscar canciones en el motor seleccionado, distinguir
resultados locales/previews, guardar explícitamente una canción y reproducirla por
el mismo programa nativo. Reutilizar descriptor sanitizado, identidad de ocurrencia,
proxy y guardas S2i; no introducir otro player ni adquisición especulativa.
Definir estados vacíos, búsqueda cancelable y respuestas obsoletas por consulta y
generación; comprobar permisos/errores y que guardar no confunda bookmark con
adquisición local. Validar UI empaquetada y rutas reales con fixture sintético,
HTTP/HTTPS, duplicados y cambio de cuenta. La autorización actual permite continuar
este alcance y revisar la paridad pendiente en PORT_PLAN.md sin volver a pedir
aprobación de cada corte. Podcasts/radio, DJ/Live y Android Auto siguen abiertos.
Offline B está aprobado; S6a se implementa antes de continuar S2j.
S2i es un artefacto de desarrollo, no una release ni una alpha pública.


## Entrega S6a: Disponible sin conexión

Implementación subida como `724a67f` en `feat/android-port-foundation`. Copias
explícitas de música adquirida desde menús de canción/colección; gestor y filtro
local en el menú de biblioteca. No hay preparación en shells ni adquisición de
previews. SQLite/archivos privados, cuotas/reserva, verificación multimedia/hash,
worker/servicio foreground y cancelación por cuenta/generación/ticket. NORMAL usa
el mismo Media3 mediante OfflineDataSource. Ver [contrato S6a](SLICE_6.md).

Offline HTTP/HTTPS comprueba lote deduplicado, motor inaccesible, reproducción,
seek/pausa/cierre, Activity recreation, límite, parcial/archivo inválido,
cancelación sin resurrección y logout local. El protocolo persistente instala
APK/tests **una vez** y usa `am instrument` en dos fases con `am force-stop` entre
ellas: restaura perfil/copia, reproduce sin API y detecta corrupción del mismo
tamaño. `connectedDebugAndroidTest` desinstala al terminar; no sirve para retener
datos entre fases. Un finally que usaba transporte después de olvidar origen
ocultaba inicialmente esa reinstalación; ambos problemas del test se corrigieron.

Validación S6a: typecheck/Vitest **1.363 tests / 149 archivos** en el checkpoint
offline; **59 Python** (58 rutas/cache y uno fixture real). **4 tests unitarios
nativos** (dos de retry y dos de reparación de socket). Suite principal completa
API 36: **15 tests, cero fallos/errores/omitidos**. Protocolo corregido de reinicio:
**dos fases de un test, cero fallos**, vía `scripts/android.py integration
--offline-restart-only`. El helper conserva por separado XML de la suite principal
y logs/result.json de cada fase. APK/test APK/lint normales pasan y no llevan CA
temporal. [Evidencia S6a](evidence/s6a.json). Las cuatro suites browser se repetirán
antes del PR acumulado exigido por AGENTS; no reutilizar S2i como resultado S6a.
No se ejecutó CI GitHub, escucha física ni aceptación de coche.

La pasada completa encontró un ETag ligado a mtime/LRU en previews y un EOF de
socket TLS reutilizado antes de cabeceras. El proxy ahora usa revisión de commit/
remux estable; admite cachés antiguas sin validator. Audio permite un intercambio
GET nuevo sólo para ese EOF en conexión reutilizada, nunca cuerpo/timeout/TLS/
cancelación/HTTP error. Se observó esa reparación en la pasada completa; cooldown
y presupuesto 429/503 siguen cubiertos. Detalles y límites en SLICE_6.

Build de instrumentación: metadata del HEAD previo (`ccec0f9`), `dirty=true`;
no presentar ese APK como build limpio de release. Se reconstruirá desde HEAD
limpio tras cerrar el siguiente corte. S6a no cierra paridad ni habilita alpha.
Autorización vigente: continuar S2j y la matriz completa, push de avances; después
PR a main y release con gates de firma/actualización y paridad completos.


## Entrega S2j: búsqueda y guardado explícito

La continuación autorizada implementa Discover de canciones: catálogo seleccionado,
resultados locales/directos/pendientes de resolución, bookmark/retirada confirmado
por API y reproducción nativa. `catalogTrack` es una función pura compartida con
web, con los mismos exports anteriores de catalogItem. No se importa el player web.
Índice de identidad Saved y links resueltos reconocen el preview actual y evitan
rematching. Última consulta/acción/cuenta prevalece; menús capturan su contexto.
No adquirir archivos, añadir fuentes especulativas ni ofrecer búsqueda offline.
[Contrato y aceptación S2j](SLICE_2.md#s2j-búsqueda-y-guardado-explícito-de-canciones).

Validación final: **1.373 tests / 151 archivos** de typecheck/Vitest; **60 tests
Python** de rutas/cache y fixtures; **4 tests unitarios nativos**. Suite APK API 36:
**17 tests principales y dos fases de reinicio**, cero fallos/errores/omitidos.
Recorridos HTTP/HTTPS: buscar, reproducir, guardar/retirar, Library, alternar cuenta
sin fuga y recuperar 403 con Retry. APK/test APK/lint normales pasan tras retirar
la CA efímera. Chromium completo: **278 pasan / 66 omitidos**; WebKit completo:
**269 pasan / 75 omitidos**, ejecución secuencial, un worker y montaje readonly.
[Evidencia S2j](evidence/s2j.json). No CI/proveedor vivo/dispositivo/coche aceptados.

La primera pasada completa detectó interferencia del fixture: reproducir Saved
preparaba la siguiente canción B y el test de preview esperaba cache fría. El
control de pruebas ahora limpia sólo las entradas sintéticas conocidas y rechaza
limpieza con fills activos; PreviewTest solicita ese estado inicial. Se conservan
las assertions de buffering/progressive, sin cambiar la política de cache real.
La repetición completa pasa. Metadata de instrumentación: HEAD anterior, dirty;
regenerar APK normal desde HEAD limpio después del commit.

Siguiente vertical después de cerrar S2j: podcasts y radio en el mismo servicio,
con resume/±15s reales y fuentes autorizadas por el motor; inventariar primero
contratos y acciones actuales. Descubrimiento de entidades, adquisición/importación,
settings/edición/lyrics/handoff, DJ/Live/Auto y firma/actualización siguen abiertos.
El usuario exige mantener paridad completa antes de integrar/publicar alpha.


### S2k: podcasts, implementado a continuación

[Contrato y aceptación end-to-end](SLICE_2K.md); resultados a continuación.

Primero, suscripciones y episodios por las rutas reales del motor, reproducción
proxy autorizada en el mismo Media3, resume y ±15s. El servicio debe guardar
progreso en background y aislarlo por origen/cuenta e identidad estable de episodio;
completados reinician desde cero. GUID/enclosure no son video IDs de preview.
No aceptar URL arbitraria ni reenviar cookie del motor al proveedor: usar tokens
mintados por el motor y construir allí la fuente interna. Incluir cancelación,
Range/seek, Activity recreation, cambio de cuenta y expiración del token con
proveedor sintético; no debilitar SSRF para el fixture. Biblioteca debe conservar
la identidad de episodios adquiridos además de las canciones.

Radio significa recomendaciones musicales NORMAL (`startRadio` y
GeneratedQueueController), no estaciones de internet. Después de podcasts, conservar
el seed ya reproduciéndose y las inserciones manuales al activar esa planificación;
no depender de timers WebView en background. Dirección/DJ/Live siguen pendientes.


## Entrega S2k: episodios, resume y ±15s

Primer vertical de podcasts implementado: suscripciones/episodios reales, refresh/
paginación, streaming proxy autorizado en el mismo Media3, progreso privado del
servicio en background, aliases enclosure/feed/GUID y controles ±15s desde posición
nativa. Biblioteca conserva episodios adquiridos separados de música: el motor no
retiene enclosure en Track; se une por feed/GUID y se enriquece el descriptor desde
RSS. Archivo adquirido y streaming comparten progreso; completed reinicia en cero.
Snapshot no entrega tokens/URLs de audio. Cada rango/apertura minta un token fresco.
Copias offline B siguen limitadas a música. Ver [contrato S2k](SLICE_2K.md).

Validación: typecheck/Vitest **1.380 tests / 153 archivos**; **6 unitarios nativos**;
**109 Python** de preview/cache, podcasts/RSS/tokens/reader y fixtures. La prueba
fixture podcast se repitió después de añadir la copia adquirida: también pasa.
Suite principal API 36: **20 tests, cero fallos/errores/omitidos**, más **dos fases
persistentes offline**. Tras ampliar aliases/recuperación y la prueba adquirida,
**tres tests podcast finales pasan** (HTTP, HTTPS verificado y store nativo).
Comprueban resume tras recreación/cierre, ±15s y límites, pausa durante recuperación
503, cambio de streaming a archivo adquirido con progreso, aislamiento de perfiles,
completion al retirar duration y proveedor sin cookies. APK/test APK/lint normales
pasan y se retira la CA temporal. [Evidencia S2k](evidence/s2k.json).

Las últimas cuatro suites browser completas son S2j; deberán repetirse sobre el
HEAD final antes del PR acumulado. No presentar esos tests como validación del
podcast APK ni marcar CI/proveedor vivo/teléfono/coche aceptados. Build de
instrumentación sobre HEAD anterior, dirty; regenerar APK limpio después de commit.
El helper ahora archiva pruebas filtradas en integration-targeted/<class>, sin
reemplazar la suite completa ni sus fases de reinicio en integration-results.

Correcciones verificadas: DataSource debe admitir reaperturas tras close para seek,
sin revivir una ocurrencia cancelada. Proxy cierra Response upstream en fin/cancel/
fallo. Tests inicialmente esperaban shell sin servidor tras recrear sesión y luego
pulsaban la fila homónima de cola; ahora esperan Library y seleccionan dentro de
PodcastBrowser. Fixture adquirido requería album en el modelo real; se corrigió,
con prueba Python del archivo/rango. No se debilitaron assertions ni SSRF.

Siguiente trabajo autorizado: ampliar podcasts con directorio y seguir/dejar de
seguir, adquisición real/progreso y acciones de episodios; después Radio NORMAL.
Continuar sin cerrar el turno por un checkpoint. DJ/Live/Auto, UI/acciones completas,
firma/actualización y demás filas de PORT_PLAN siguen siendo requisitos antes del
PR/merge/release. No se ha publicado alpha parcial ni integrado a main.

## S2l: directorio y adquisición podcast

[Contrato S2l](SLICE_2L.md). Implementados búsqueda, RSS sin suscripción implícita,
follow/unfollow confirmado y adquisición durable con fallo/retry/cancel desde
menús de tres puntos. Unfollow conserva archivos. Streaming y adquirido comparten
progreso. GUID sin feed/RSS coincidente nunca une shows diferentes. La cola elimina
los completados: refrescar Library cuando desaparecen, confirmar archivo allí.
Observación se aborta al desconectar y retoma al reconectar.

Resultados locales: UI **1.387 tests / 154 archivos**; Python **44 tests** de pump,
recovery, persistencia, podcasts y fixture real de adquisición. Dos APK tests HTTP/
HTTPS del directorio pasan. Regresión principal: **22 tests, cero fallos/omitidos**
según TestRunner, más **dos fases offline persistentes** que pasan. El helper
terminó correctamente y retiró la CA temporal. Su build normal ya incluyó fuentes
de Radio en desarrollo: no es un APK limpio del commit S2l ni valida Radio. Últimos browser completos siguen siendo S2j.

Ruff check pasa. Format check de fixture/test pasa; shared/api/__init__.py tiene
formato histórico fuera del cambio, no se reformatea entero por este slice. Su
cambio cierra Response upstream del downloader podcast mediante context manager.

Continuación activa: Radio NORMAL nativo. No cerrar por este checkpoint. No se ha
creado PR, integrado main ni publicado release; paridad completa sigue obligatoria.

## S2m: primer vertical Radio NORMAL nativo

[Contrato y pendientes](SLICE_2M.md), [evidencia](evidence/s2m.json).
Planner real `/api/discovery/music/plan`, propietario servicio, seed estable,
lookahead y cancelación por cuenta/cierre/reemplazo. Activar sobre actual conserva
ocurrencia, pausa y posición. Append manual entra delante de recomendaciones;
Stop Radio retira sólo sus futuras ocurrencias. Snapshot distingue recomendaciones.
Extras preview/radio coexisten. Reemplazar cola se hace en el servicio y se observa
por IPC con token nuevo incluso si los IDs se repiten.

Validación: UI **1.389 / 154** antes de S2n; Python **14** planner y fixture real
con adquisición sintética/stream Range. APK **tres tests** (HTTP, HTTPS verificado,
decoder acotado). Regresión principal **25 tests, cero fallos/omitidos**, más **dos
fases persistentes offline que pasan**. El Radio final comprueba fallo inicial 503,
retry con Activity CREATED, regreso/recreación, seed/pausa/seek conservados,
deduplicación, append manual por delante y Stop Radio conservando las dos peticiones
manuales. No confundir este vertical con Radio/autoplay completamente aceptados:
refill automático tras avance, perfil/UI completos, recuperación/cancelación
extendidas y proveedor vivo siguen pendientes. DJ/Live/Auto mantienen sus gates.

Primeros fallos fueron del setup: transporte antes de configurar origen, luego
comando antes del primer snapshot. Se esperó estado ready real. Endpoint fixture
stats tenía nombre Flask repetido: ahora radio_stats es único. No se debilitaron
las assertions. Normal APK/lint se reconstruyen sin CA temporal; mientras S2n
está en curso el árbol/build son dirty, no artifact limpio de release.

Continuación activa S2n: favoritos explícitos, filtro/estados de filas y selector
playlist sin runtime web de audio. Sus **37 tests backend** y **1.395 /156 UI**
pasan antes de los últimos guards de prompt. APK todavía pendiente. Sus fuentes
están separadas del commit S2m; no dar acciones por aceptadas sólo por scaffolding.
Continuar hasta la paridad y después PR/merge/release autorizados; no finalizar por
este checkpoint ni cambiar el requisito a alpha parcial.

## S2n: favoritos y pertenencia playlist validados

[Contrato](SLICE_2N.md), [evidencia](evidence/s2n.json). PUT favourites con intención
explícita e idempotente; el toggle anterior conserva contrato. Unmark de canción
eliminada no la vuelve a guardar. Canciones adquiridas no necesitan resolver otro
video al marcarse. Filas compartidas y filtro favoritos reflejan snapshot confirmado.
Selector create/add comparte estilos/textos, confirma ID en playlist y refresh
antes de cerrar; preview se guarda por identidad sin adquisición. Cuenta reemplazada
aborta selector y cierra prompt; callbacks capturados no migran.

UI **1.396 tests /157 archivos**; Python **44** manager/promoción/rutas; APK **dos
HTTP/HTTPS verificado**, incluidos favourite/unmark/filtro, archivo conservado,
playlist creada con un ID confirmado y owner sin playlist del member. No hay audio
HTML. APK/test/lint normal pasa sin CA temporal. Última regresión completa sigue
siendo S2m **25 + dos restart**, anterior al APK S2n; browser completos siguen S2j.
Repetir ambos sobre el head final antes del PR. Build source_revision anterior,
dirty: no artifact limpio ni release. Filtro favorito no persiste metadata de
marks en arranque offline frío; no confundirlo con copias de música S6a.

Continuación: gestión completa de playlists/acciones, Radio/autoplay completos y
resto de paridad de PORT_PLAN. Mantener commit/push en rama por trabajo validado,
seguir sin terminar el turno por un slice. PR/merge/release sólo al cerrar gates.

## S2o: gestión de playlists validada

[Contrato](SLICE_2O.md), [evidencia](evidence/s2o.json). Rename/duplicate/delete,
orden persistido y carátula adquirida en menús. Filas filtradas conservan la
ocurrencia original aunque repitan ID. Nuevas rutas de edición exigen snapshot
capturado; 409 conserva cambios concurrentes y motores antiguos no reciben una
escritura incondicional de fallback. Todo el payload se valida antes de modificar.

UI **1.400 tests /159 archivos**, Python **149**, APK **dos HTTP/HTTPS verificado**
pasan. El recorrido confirma pertenencia y orden en servidor y pantalla antes de
capturar la siguiente operación. Los primeros fallos eran observaciones del test
anteriores al refresh: añadir una canción y ordenar devolvían antes de actualizar
la UI; se mantienen los guards CAS. El test AutoMode dejaba un timer tras teardown:
fixture ahora drena timers y cleanup, sin modificar gesto de producto; commit
`1e1f2fe` subido por separado. La repetición UI no tiene errores sin capturar.

Última suite APK completa sigue S2m 25 + dos fases restart; browser completos S2j.
Repetir sobre head final antes del PR. Instrumentación dirty/HEAD previo, no release.
Continuación activa: perfiles/refill/cancelación de Radio NORMAL, autoplay y resto
de matriz. No finalizar por checkpoint; PR/merge/release requieren paridad completa.

## S2p: perfiles Radio y refill en background

[Contrato](SLICE_2P.md). Menú de canción actual añade Familiar/Equilibrado/Explorar
con selección observada; replantear conserva current y pausa. Comando de UI envía
key y el servicio rechaza una ocurrencia antigua aunque el token de cola siga igual.

UI **1.401 tests /159 archivos** pasa. APK **dos HTTP/HTTPS verificado** pasan en
`/tmp/soundsible-s2p-native-observed.log`: avanzar al umbral, Activity CREATED,
planner/refill sin WebView, crecimiento sin duplicaciones nuevas, vuelta al seed,
Explore desde menú real, pausa/key conservadas, comando stale rechazado, Stop
Radio conserva tres ocurrencias manuales. No confundir append manual duplicado
intencionadamente con duplicación de recomendaciones.

Correcciones del recorrido: snapshots periódicos podían capturar token anterior
a la respuesta inicial del planner; helper consulta estado fresco antes de comandos
y falla inmediatamente ante rechazo. Explore puede devolver `degraded` con
recomendaciones locales válidas: comprobar candidates además de ready/degraded.
Cadenas de evaluateJavascript son JSON, no texto sin comillas. Una pasada bajo
carga dejó WebView sin responder; la repetición secuencial llegó al diagnóstico
real y la final pasa. No se debilitan guards de escritura o se inventa éxito.

Suite completa anterior sigue S2m 25 + restart2; browser S2j. Instrumentación
sobre HEAD S2o dirty, desarrollo. Continuar [S2q autoplay](SLICE_2Q.md) y matriz
completa; ningún checkpoint termina autorización PR/merge/release tras paridad.

## S2q: primer vertical autoplay NORMAL validado

Fuentes dirty posteriores a S2p `e059b85` (subido). [Contrato S2q](SLICE_2Q.md).
AutoplayProgram carga/escribe preferencia real en worker nativo, guards de serial/
generación, seed móvil, umbral manual, repeat/podcasts/Radio, prioridad manual y
cierre. RadioProgram comparte intent/decoder/retry sin compartir sesión; tanda
corta vuelve a comprobar runway. Cola distingue Autoplay/Radio, ajuste en menú
programa de tres puntos y respuesta observada. Fixtures deterministas fijan
preferencia false por cuenta; default de producto sigue true.

UI **1.402 /159**, cuatro Python fixtures reales y Ruff pasan. APK dos HTTP/HTTPS
pasan en `/tmp/soundsible-s2q-native-confirmed.log`; menú real, threshold manual,
refill background, disable confirmado, repeat, Radio y cierre. Normal APK/lint
sin CA también pasa. Suite completa final **31, cero fallos/omitidos**, más **dos fases persistentes
offline que pasan**, log `/tmp/soundsible-s2q-native-main-final.log`. APK/test/lint
normal pasa sin CA temporal. Primera suite tuvo dos fallos de PlaylistManagement:
Move up suponía que sólo había dos listas, pero LibraryActions creaba una tercera.
Ahora observa posición anterior y verifica intercambio/preservación; repetición
completa pasa. Última browser completa sigue S2j; repetir antes del PR final.

Tests corrigieron el uso de índice antes de observar runway y la expectativa de
activar autoplay con tres peticiones manuales futuras: el guard era correcto.
El caso repeat avanza primero para aislar esa política del umbral manual. Quedan
podcast/cancelación/cuenta con planner pendiente y recuperación extendida antes
de llamar autoplay completo. [S2r metadatos](SLICE_2R.md) es contrato siguiente,
no implementación. Continuar sin finalizar por checkpoint hasta paridad/release.

Continuación activa S2r: formulario de metadata extraído sin stores/audio web y
adaptador Native REST, todavía sin conectar a programa/shell. Typecheck y tres
tests de presentación pasan; Native metadata/artwork y recorrido APK pendientes.
Estos archivos no pertenecen al APK de aceptación S2q ni al commit de autoplay.
Mantener commits separados y continuar hasta paridad/PR/merge/release autorizados.


## S2r: primer vertical de metadata/carátulas

[Contrato/evidencia y pendientes](SLICE_2R.md). Editor visual compartido sin stores
ni audio web, adaptador REST capturado por cuenta, actualización de metadata en
Media3 preservando fuentes/ocurrencias y labels offline en SQLite. Dos tests APK
HTTP/HTTPS pasan sobre WAV; UI 1.405/160 y Python 49 pasan. Multipart real y bitmap
privado confirmado; File sintético no acepta selector OS. Fix WAV metadata/artwork
sidecar y null album_artist fallback.

**No es todavía edición completa**: formatos con tags pueden rehash/cambiar ID
con las rutas históricas. Continuar con contrato de edición que preserve audio/ID
y pruebas de formatos con tags antes de cerrar esta fila. Última APK completa
S2q31 + restart2; browser S2j. No PR/main/release hasta matriz completa; continuar
sin terminar por checkpoint. Instrumentación dirty/HEAD anterior, desarrollo.


## S2s: edición conservando audio/identidad

[Contrato y evidencia](SLICE_2S.md). Nuevas rutas track-labels editan canonical y
sidecar sin tags/rehash. Android exige storage=library e ID original; motores
antiguos fallan explícitamente sin fallback destructivo. Resuelve el límite de
formatos con tags señalado en S2r. UI 1.409/161; Python 66 + cuatro fixtures pasan;
APK FLAC y WAV, HTTP/HTTPS, cuatro recorridos pasan con SHA-256 de audio conservado.
Normal APK/lint sin CA pasan. Selector OS y aceptación APK extendida pendientes.

Fuentes de instrumentación dirty respecto a S2r; regenerar desde commit limpio y
repetir suite principal + restart. Últimas browser completas S2j; repetir cuatro
perfiles antes del PR. Continúa paridad de biblioteca/entidades, DJ/Live/Auto,
firma/actualización; no dar matriz por completa ni publicar alpha parcial.


## Continuación S2t y regresión S2s

Commit S2r `76099a2` y S2s `1cce3ca` subidos. La suite principal S2s sobre assets
preparados desde HEAD limpio terminó **33 tests, un fallo, cero omitidos** en
`/tmp/soundsible-s2s-main.log`; no alcanzó las fases restart ni el rebuild normal.
El fallo HTTP CatalogSearch abrió un menú con Save después de confirmar Saved en
servidor: refresh concurrente podía devolver sin esperar el snapshot que lo sustituyó.
No debilitar la assertion. Última regresión completamente verde sigue S2q31+restart2.

Corrección en desarrollo: createAccountRefresh coalesce por epoch y espera la
observación encolada; cuenta anterior no reencola ni libera la actual. Dos tests
de contrato pasan. [S2t](SLICE_2T.md) añade acciones bookmark album/artist adquiridos,
identity helpers puros compartidos y snapshot saved-entities por cuenta; no guarda
canciones ni archivos. UI **1.416/163**, Python saved-entities **15** pasan.
Recorrido APK conjunto CatalogSearch + EntityBookmarks en curso; repetir principal
y restart tras corregir todos sus fallos. No presentar S2t como validado todavía.
Continúa autorizado hasta matriz completa, PR/merge/release; no finalizar por slice.


## S2t: bookmarks adquiridos validados

[Contrato y pendientes](SLICE_2T.md), [evidencia](evidence/s2t.json). Save/Remove en
menús de álbum/artist y cabecera con identidad library. Snapshot privado por cuenta,
misma identidad pura que web, sin guardar/adquirir canciones ni iniciar audio.
UI **1.416/163**, Python **15**, APK **cuatro tests HTTP/HTTPS de EntityBookmarks y
CatalogSearch pasan**; normal APK/test/lint sin CA pasa. Refresh corregido y subido
aparte `190c5b4`; no se debilitó assertion Saved. Fallos iniciales de bookmarks
eran espera unconfigured tras recreate y checkmark incluido en textContent.

Repetir principal/restart ahora: última completa S2s33 tuvo un fallo Saved, última
verde S2q31+restart2. Browser completos S2j todavía no equivalen al HEAD actual.
Pendientes entidades externas/listas de bookmarks/navegación Discover, selector
OS real, biblioteca restante, DJ/Live/Auto y firma/actualización. No cerrar turno
por checkpoint, ni publicar una alpha parcial. Instrumentación dirty/HEAD anterior.


## Aislamiento auth de fixtures, continuación

La principal S2t35 tuvo un fallo de LibraryActions HTTP: login owner recibió 429
por presupuesto acumulado de casos anteriores. Repro Connection+EntityBookmarks+
LibraryActions **8, un fallo**, auditoría status confirma429; repetición con
FixtureIsolationListener **8, cero fallos/omitidos**, normal APK/lint sin CA pasa.
[Detalle y comandos/evidencia](AUTH_FIXTURE_ISOLATION.md). Python real prueba que
10 intentos fallidos→401, siguiente→429, reset no autorizado no altera límite,
reset de fixture autorizado permite login. No cambia protección de producción.

El helper integration instala listener para resetear sólo auth_login entre casos;
no borra cuentas/cookies/colas/copias y deja restart offline con su protocolo.
Volver a ejecutar principal/restart sobre HEAD final. [S2u](SLICE_2U.md) selector
OS todavía es contrato/draft (draft reproducible en docs/android/drafts/CoverPickerTest.java),
no aceptado; trasladarlo a androidTest y probar después de cerrar esta regresión.
Continuar hasta paridad completa; PR/main/release siguen pendientes.


## Regresión principal S2t final

Sobre assets preparados desde HEAD limpio `cf01599`, la repetición final de
`/tmp/soundsible-s2t-main-isolated.log` pasa **35 tests principales, cero fallos/
omitidos**, más **dos fases offline persistentes** tras force-stop. Helper termina
correctamente, retira CA y rebuild APK/test/unit/lint normal pasa. No confundir
este resultado con las principales S2s33/S2t35 que fallaron antes de los fixes.

Siguiente trabajo: mover draft S2u a androidTest y validar selector OS real (tap,
Back, content URI/bitmap). Revisar también prioridad de artwork: BitmapLoader de
Media3 instalado prefiere artworkData embebido sobre artworkUri, que puede ocultar
un sidecar editado sin reescribir audio. Necesita test de metadata/cover con audio
FLAC que lleve artwork embebido y verificación de sesión multimedia antes de dar
ese caso por aceptado. No está corregido todavía; no llamar completa la paridad.

Diff acumulado detectó blank line final en catalogTrack heredado de S2j; eliminado
sin cambiar lógica. Browser completos siguen S2j hasta repetición previa al PR.
Continuar hasta todos los gates de paridad, luego PR/main/release autorizados.


## S2u selector OS real

[Detalle](SLICE_2U.md). Instrumentación ahora en androidTest, draft retirado. Dos
casos HTTP/HTTPS pasan: toque real, Back sin escritura, selección del PNG privado
sembrado mediante MediaStore, content grant normal y bitmap recibido en motor.
Photo Picker oscurece/remuestrea la miniatura y anima su hoja: identificar patrón
verde/magenta por geometría, rechazar ambigüedad y exigir estabilidad antes del tap.
No ampliar permisos ni simular callback/File. Lint posterior pidió @SdkSuppress
en lugar de @RequiresApi; corregido. APK/test/unit/lint normales sin CA pasan
en /tmp/soundsible-s2u-normal.log.

Prioridad de sidecar frente a artwork embebido cerrada después en S2v; ver último
apartado. Matriz restante y publicación siguen pendientes.


## S2v sidecar y portada embebida

[Contrato/evidencia](SLICE_2V.md), [registro](evidence/s2v.json). ProgramArtwork da
prioridad a URI privada sobre embedded; generation caducada falla sin fallback
a imagen anterior. Sin URI mantiene embedded; sin ambas null. Cuatro tests reales
HTTP/HTTPS FLAC pasan, incluido verde editado en sesión multimedia y SHA-256/ID/
cola/posición/copias preservados. APK/test/unit/lint normal sin CA pasa.

FLAC fixture ahora contiene portada embebida y Radio copia formato real; Python
WAV/FLAC dos tests pasan. Primer intento asumió artworkData en metadata fusionada
del MediaController: puede omitirse cuando la app aporta URI. Se verifica fuente
FLAC con MediaMetadataRetriever y sesión del sistema por separado.

Letras temporizadas compartidas completadas después en S2w. Continuar acciones biblioteca,
Discover/adquisición/importación/Settings, DJ/Live/Auto y release gates. Principal
completa última S2t35+restart2; tras S2u/S2v hace falta regresión final ampliada.
No cerrar por slice; continuar hasta PR/main/release de paridad completa.


## S2w letras nativas compartidas

[Detalle](SLICE_2W.md), [evidencia](evidence/s2w.json). LyricsPanel web adaptador
con mismos stores; LyricsPanelView puro de audio con track/posición/seek inyectados
y requests abortables. Android abre desde menú del programa, scroller propio,
no podcasts, no acción sin conexión. Panel cierra al cambiar cuenta/programa.

UI1.419/164 pasa; dos casos HTTP/HTTPS en API36 pasan adquirido y preview guardado:
seek20s, highlight/aria-current, pausa/keys/token preservados, cierre/logout sin
panel/programa anterior. Preview en Library no es adquirido: lookup metadata con
sourceKind verificado o unverified; unverified sólo texto sin tiempos. Fixture
usa cache DB real, no mock del IPC. Logs /tmp/soundsible-s2w-ui-preview.log y
/tmp/soundsible-s2w-native-preview.log. Assets dirty desde 9bc041d. APK/test/unit/lint normal sin CA pasa. Proveedor LRCLIB vivo/físico pendientes.

Adquisición desde previews completada después en S2x; ver último apartado. Mantener identidad en reproducción al promocionar
preview a adquirido; no sustituir ocurrencias ni arrancar otro output. Resto
Discover/importación/Settings/compartir/multidispositivo, DJ/Live/Auto, firma/update
y release gates siguen pendientes. No cerrar el turno por slice.


## S2x adquisición y promoción sin cambiar ocurrencia

[Contrato](SLICE_2X.md), [evidencia](evidence/s2x.json). Menús Download en Library/
Search, cola real con filas web compartidas, progreso/retry/cancel/clear confirmados
y privados por cuenta. Eventos downloader_update y polling mientras activo.
Claves exactas mantienen marcador adquirido con hash aunque siga sonando preview;
no reemplaza URI/keys/token/posición ni output durante adquisición.

UI1.425/167, Pythonpipeline1 y APK2 HTTP/HTTPS pasan. Native pausa20s, fallar/retry,
adquirido hash real con marcador, cancelSearch activo sin archivo, reproducción
local explícita y stop. APK/test/unit/lint normal sin CA pasa. Primer intento salió
de Search antes de resolver/aceptar job; se corrigió el test, no el guard de cuenta/
unmount. Test restaura Saved/controles y elimina sólo archivos de su fixture.

Fixture sustituye sólo _download_audio por bytes sintéticos; procesado/tags/hash/
store/cola/pool/transacción personal siguen reales. Python demuestra Range/owner
no ve ni retira jobs de member/cancel tardío no promueve archivo. No YouTube vivo
ni escucha física aceptados. Sources assets dirty desde b364905.

Continuar importación: baseline actual es Migrate.tsx y migrationApi jobs/upload/
start/control/decision, no sólo APIs legacy preview/import-playlist. Reutilizar
vista con navegación/cuenta/lifetime inyectados y selector OS real para exports.
Inventariar límites multipart y formatos admitidos antes de modificar transporte.
Después resto biblioteca/Discover/Settings/share/multidispositivo, DJ/Live/Auto,
firma/update/release gates. Principal completa última35+restart2; ahora41 tests
principales esperados más restart2 y browser4 a repetir sobre implementación final.
No cerrar por slice; continuar hasta paridad completa y PR/main/release autorizados.


## Entrega S2y: migración compartida y grant OS con streaming

[Contrato](SLICE_2Y.md), [evidencia](evidence/s2y.json). MigrateView mantiene guía,
selección, progreso, controles/revisión y restore web; Migrate es adaptador router.
La superficie Android inyecta origen real /migrate, chooser y apertura Playlists.
AbortSignal/lifetime irrevocable y revisión de job impiden respuestas antiguas de
restore/poll sobrescribir una mutación confirmada. Unmount aborta queries/upload;
una cancelación del selector conserva guía y no crea job. ToastOutlet compartido
hace visibles errores/confirmaciones nativos.

ACTION_OPEN_DOCUMENT sólo entrega a JS token opaco y metadatos; URI privada,
perfil, generación y fingerprint de sesión quedan nativos. Token una vez/10min,
request normal conserva errores HTTP/401, stream 64KiB y tope100MiB, sin base64.
Metadatos de documentos usan workers/cola acotados, CancellationSignal y deadline;
lectura de contenido y lease se cierran por cancelación/cambio/destroy/timeout.
MIME application/* y text/* evita excluir exports por variantes del proveedor;
parser valida contenido/extensión. No permisos amplios ni persistir grants.

UI1.430/167 y backend migración30 pasan. APK2 HTTP/HTTPS sin fallos/omisiones:
selector real, cancelación sin job, CSV/matcher member-track, restore al volver,
start/completion, playlist exacta y Open library aterriza en Playlists, sin audio
HTML. APK/test/unit/lint normal sin CA temporal pasa. Tests de stream cubren tamaño
conocido/desconocido, límite, no replay, cierre y cuenta invalidada.

Correcciones durante aceptación: generación JS puede ser Integer (getLong sólo
no basta); aislar guía persistida por caso; navegar OS Recientes/Descargas;
KeyEvent con fuente keyboard y MotionEvent con TOOL_TYPE_FINGER. Tool type UNKNOWN
no acreditaba un tap de dedo en DocumentsUI. Nunca simular resultado de picker.

Sources assets dirty desde4be3e2d; no artifact de alpha. Proveedores de documentos
cloud/otros fabricantes, exports reales Spotify/Apple y casos complejos controls/
review en APK siguen pendientes de aceptación extendida (contratos backend y UI
compartidos probados). [S2z](SLICE_2Z.md) es el siguiente slice: Atrás real para
menús/overlays, colecciones/podcasts/pestañas y raíz minimizada sin parar programa.
Principal completa última35+restart2; ahora43 principales esperados+restart2;
repetir completa y browser4 sobre implementación final. Después completar resto
biblioteca/Discover/Settings/share/multidispositivo, DJ/Live/Auto, firma/update y
PR/main/release autorizados. No finalizar por slice.


## Entrega S2z: Atrás del sistema y limpieza de navegación

[Contrato](SLICE_2Z.md), [evidencia](evidence/s2z.json). App.backButton prioriza
menú/modal superior y handlers con owner Solid para detalle/pestaña; en raíz
minimiza sin tocar audio/sesión. Consulta de detalle Library y feed Podcast
cancelados al volver; respuestas viejas no reabren vista. Listener tardío tras
unmount se retira y no minimiza otra instancia. No simular Escape ni DOM buttons.

UI1.438/168 y APK2 HTTP/HTTPS pasan. KeyEvent keyboard/FROM_SYSTEM: colección →
Playlists → Songs; cerrar menú, editor y letras; show → directorio → Library;
Downloads → Library; raíz minimiza y volver conserva keys/token/pausa20s/cookie.
Revocación con menú abierto elimina ventana/datos personales y vacía programa.
Cookie sólo se compara nativamente, nunca se imprime. APK/test/unit/lint normal
sin CA temporal pasa. Assets dirty desde8cfd77c.

Corregido registro de overlays huérfano tras desmontar Outlet: discardOverlays
limpia scopes/listeners de historia sin navegar por debajo; reset de cuenta lo
usa junto con cierre de popover. Modal protegido consume Back hasta terminar o
hasta perder cuenta. El primer intento pasó navegación/minimizar, pero el helper
esperaba app sin servidor al volver; test corregido para app conectada real.
No aceptación de hardware/gesto predictivo/fabricantes.

Ahora45 tests principales esperados +restart2; repetir principal completa y
browser4 por limpieza global y extracciones compartidas recientes. Continuar
acciones restantes de biblioteca (retirar archivo y referencias/programa/copia),
entidades/Discover/Settings/share/multidispositivo, DJ/Live/Auto y firma/update.
No cerrar turno por slice ni publicar antes de paridad; PR/main/release después.
