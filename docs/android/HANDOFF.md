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

Continuar S2 con el contrato asíncrono en el runtime autenticado Solid y retirar
la superficie/controles temporales al tener un reemplazo probado. Añadir
previews/podcasts/resume/±15s/radio y artwork de MediaSession, según
[la continuación de S2a](SLICE_2.md). No introducir un segundo dueño Web Audio.
Mantener las aceptaciones de despliegue/phone de S1 y todos los gates de paridad.

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
