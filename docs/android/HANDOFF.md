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
- Offline no está decidido. Caso de interés: un vuelo. Preocupan la lógica,
  sincronización y dos botones «Descargar». **Resolver con el usuario antes de
  la alpha; implementar sólo si se aprueba.** No convertir una idea en requisito
  implementado ni decidir por omisión. Ver OFFLINE_DECISION.
- No hay teléfono Android propio. Separar emulador, dispositivos remotos y
  teléfono/coche reales; no llamar a CI aceptación acústica.
- Cada implementación termina con commit en rama, nunca main. Esta preparación
  autorizaba inicialmente sólo commit. La instrucción posterior autoriza push;
  no autoriza PR, merge ni publicación. No delegar sin autorización.
- Respetar AGENTS: versión central, nada de `npm run build` local, suite completa
  de cuatro perfiles cuando se toca `ui_web`, y base remota actual/impact label
  si posteriormente se solicita PR.
- La app iOS es Swift independiente, no Solid sincronizado. Su runtime sigue
  sin validación de dispositivo. Mantener las advertencias sobre iOS/PAL.

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

### Siguiente corte propuesto: S2i, preview nativo por el proxy del motor

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
