# Historial del port Android

Registro conservado de avances y diagnósticos. Para decisiones y estado vigente,
leer [HANDOFF.md](HANDOFF.md); este historial contiene resultados superados.

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
  Autorización vigente (actualizada 2026-10-05): continuar hasta paridad completa,
  hacer commit/push y dejar la PR abierta con todos los checks pasando para review
  manual del usuario. No hacer merge ni activar automerge. Preparar documentación
  e instrucciones de alpha; no publicar release antes de su revisión y merge.
  Esta instrucción revoca cualquier autorización anterior de merge/release.
  El usuario confirma mantener paridad completa antes de alpha (no alpha parcial).
  No delegar sin autorización.
- Respetar AGENTS: versión central, nada de `npm run build` local, suite completa
  de cuatro perfiles antes de abrir PR que toque `ui_web`, y base remota actual
  e impact label al abrir la PR autorizada tras completar la paridad; dejarla abierta.
- La app iOS es Swift independiente, no Solid sincronizado. Su runtime sigue
  sin validación de dispositivo. Mantener las advertencias sobre iOS/PAL.

## Estado actual de continuación

S3a queda validado sobre commit limpio d049f40481dc1626d2d037186241dedffe794ed7
(dirty=false): principal78/0, restart prepare1/0 y force-stop/offline1/0 con PCM
real y preferencia por perfil. APK/test APK/JVM27/lint normales pasan después de
retirar la CA temporal. Log /tmp/soundsible-s3a-main-isolated-clean-native.log;
XML actual confirma78/0/0/0. Sustituye principal limpia73 anterior al DSP.
WAV/FLAC dirigidos, Radio/parser/Autoplay6 y planner Python79 también pasan.
Ver [S3a](SLICE_3A.md) y [evidencia](evidence/s3a.json). El primer principal78/2
falló por asumir dos pistas en el álbum ampliado por Radio; se conserva diagnóstico
y el fixture de álbum PCM propio corrige el problema sin borrar otras filas.

Siguiente: integrar y compilar [mezcla DJ](SLICE_3B.md), probar dos decodificadores
privados mono16k/estéreo48k normalizados a estéreo48k, con un único AudioTrack,
FX/limiter y salida post-DSP/pre-volumen. Spike integrado en fuentes y tests: compilación Kotlin Native/test, JVM36/0
y lint pasan (/tmp/soundsible-s3b-mix-foundation-fixed.log). AudioTrack HTTP/TLS2/0 pasa sobre16ed5d83 limpio: espectro440/880, formatos
normalizados, volumen local independiente y continuidad tras liberar saliente;
APK/test/JVM36/lint normal pasa, log /tmp/soundsible-s3b-mix-looper-native.log.
No conectado al servicio ni DJ aceptado. Pausa/reanudación y clearSession real también pasan HTTP/TLS2 y build normal
sobre4b6489ee limpio, log /tmp/soundsible-s3b-mix-pause-native.log.
Seek con marcador440→1320 real también pasa HTTP/TLS2 y build normal
sobre6d0626a0 limpio, log /tmp/soundsible-s3b-mix-seek-replacement-native.log.
Dominancia25/75% con reloj físico y corte direct también pasan HTTP/TLS4
sobre5f762ba1 limpio, normal APK/test/JVM38/lint pasa, log
/tmp/soundsible-s3b-mix-direct-native.log. Caída real del decoder entrante durante blend pasa HTTP/TLS6 sobref001e95a
limpio, PCM saliente/rampa y dominancia restauradas, normal APK/test/JVM38/lint
pasa. Log /tmp/soundsible-s3b-mix-recovery-native.log. Clock por tramos y caída tardía95% pasan HTTP/TLS8 sobreca242c26 limpio,
normal APK/test/JVM41/lint pasa. Log /tmp/soundsible-s3b-mix-clock-resume-native.log.
Siete técnicas/FX pasan HTTP/TLS18 sobree0499c4e limpio: bass/filter/long/echo
con espectros reales, structural/direct y regresiones; normal APK/test/JVM41/lint
pasa. Log /tmp/soundsible-s3b-mix-fx-ready-native.log. WAV+FLAC real pasa HTTP/TLS2 sobref5178e54 limpio, normal APK/test/JVM41/lint
pasa, log /tmp/soundsible-s3b-mix-codec-native.log. EOS HTTP/TLS2/0 y normal
APK/test/JVM41/lint pasan sobref180e8ea limpio, log
/tmp/soundsible-s3b-eos-silence-native.log. Tempo HTTP/TLS2/0 y normal
APK/test/JVM41/lint pasan sobreb2e208b8 limpio, log
/tmp/soundsible-s3b-tempo-native.log. Cue/preroll HTTP/TLS2/0 y normal
APK/test/JVM41/lint pasan sobree7e36547 limpio, log
/tmp/soundsible-s3b-cue-native.log. Cancelación y seek standby HTTP/TLS2/0
y normal APK/test/JVM41/lint pasan sobre53717d2f limpio, log
/tmp/soundsible-s3b-cancel-reservation-native.log. Retorno rate HTTP/TLS2/0
y normal APK/test/JVM41/lint pasan sobre5b5dbed8 limpio, log
/tmp/soundsible-s3b-rate-return-native.log. Regresión completa spike32/0
y normal APK/test/JVM41/lint pasan sobref2e7a921 limpio, log
/tmp/soundsible-s3b-complete-spike-native.log; niveles por entrada incluidos.
LongBlend48s HTTP/TLS2/0 y normal APK/test/JVM48/lint pasan sobrebbfcd056
limpio, log /tmp/soundsible-s3b-long-end-native.log; política fromKey7 JVM verde.
Pérdida de entrada/salida early/late HTTP/TLS8/0 y normal APK/test/JVM48/lint
pasan sobreb210eeb3 limpio, log /tmp/soundsible-s3b-outgoing-loss-native.log.
Fachada estable ProgramPlayerRouter conectada al PlaybackService sobre el backend
NORMAL existente; dirigido APK2/0 y normal APK/test/JVM48/lint pasan sobre71ab534b
en /tmp/soundsible-s3b-router-fixed-native.log. Forwarding e aislamiento de eventos
al sustituir backend aceptados; regresión NORMAL completa todavía pendiente.
El cambio de backend exige anterior parado y siguiente sin play solicitado;
la fachada conserva la identidad MediaSession.
Integración DJ en fuentes: ProgramDjPlanner/Core, ProgramDjSession/route,
ProgramMixPlayer/focus único, tap mezclado y comando From current en menú.
Kotlin Native/test, JVM48 y lint pasan en
/tmp/soundsible-s3b-dj-e2e-foundation.log. Primer flujo end-to-end aceptado sobre
9d64d5a3 limpio: DJ HTTP/TLS2 + NORMAL PlaybackTest HTTP/TLS2, todos verdes;
normal APK/test/JVM48/lint pasa. Log /tmp/soundsible-s3b-dj-normal-native.log.
DjProgramTest ejecuta Core real, bridge/servicio, PCM mixto en background,
dominancia, pausa, recreación Activity y retorno NORMAL. No declarar paridad DJ.
Faltan refill/dirección/edición completa y ampliar recuperación/phase/OS controls.
Reservar suites completas para cierre del bloque, usar dirigidos durante integración.

Continuación DJ: route editable conservando las ocurrencias comprometidas, replan
de futuro y refill sobre el mismo backend; settings nativos con perfil/dirección/
fuentes y perfiles en menú de tres puntos. Dirigido DJ HTTP/TLS + NORMAL4/0,
normal APK/test/JVM/lint pasan en /tmp/soundsible-s3b-dj-route-native.log sobre
working tree (dirty=true), no evidencia de commit limpio. UI dirigido18/0 y
TypeScript pasan en /tmp/soundsible-s3b-dj-settings-ui.log. La prueba verifica
append/move/remove en pausa y cambio de perfil sin sustituir la ocurrencia actual
ni avanzar su posición. No demuestra refill largo ni reemplazo efectivo de futuro:
el source set de dos pistas puede agotarse. Faltan UI de dirección/fuentes,
inicio sólo desde fuentes, refill real y recuperación de decoder en producción.

UI de dirección añadida al menú de tres puntos: energía, familiaridad y prompt,
con include/exclude retenidos. Editor ligado a la identidad del programa; error
reintentable y cierre al cambiar owner. Dirigido20/0 y TypeScript pasan en
/tmp/soundsible-s3b-dj-direction-ui.log. Aún falta probar que Core aplica un
prompt real al futuro y completar selección de fuentes e inicio sin canción.

Menús de colecciones permiten iniciar DJ sin seed, añadir o quitar una colección
como fuente con guards de cuenta/programa y límites de payload. Dirigido UI22/0
y TypeScript en /tmp/soundsible-s3b-dj-sources-ui.log. DJ HTTP/TLS2/0 y normal
APK/test/JVM/lint pasan en /tmp/soundsible-s3b-dj-sources-native.log (dirty=true):
Core elige opening real desde source set y crea una nueva identidad de programa.
Pendiente refill efectivo con más de ocho candidatos y cambio efectivo de fuentes.

Refill y reemplazo efectivo de fuentes aceptados: DJ HTTP/TLS2/0, normal
APK/test/JVM49/lint en /tmp/soundsible-s3b-dj-refill-resampler-native.log
(dirty=true). La prueba salta dentro de un set de diez pistas adquiridas, fuerza
refill9→10, cambia a fuentes PCM y conserva KEY/pausa/posición del input actual.
Encontró un fallo real: Sonic.reset borra el target48k al parar/reusar decoder.
ProgramResampler configura48k en cada stream y delega ambos flush explícitamente;
regresión JVM dedicada pasa (/tmp/soundsible-s3b-resampler-unit.log).
Se conservan diagnósticos fallidos en /tmp/soundsible-s3b-dj-refill-native.log y
/tmp/soundsible-s3b-dj-refill-fixed-native.log. Siguiente bloque: recuperación
en producción, controles/focus de sesión DJ y regresión completa del servicio/UI.

Regresión UI completa pasa198 archivos/1556 tests + TypeScript, log
/tmp/soundsible-s3b-dj-direction-parity-full-ui.log. Editor usa parseDjDirection
compartido (sin mixer web): texto reconocido se traduce a controles/include/exclude;
sliders conservan valores fraccionarios. Prueba de «más suave» y retry conserva
exclusiones, dirigido2/0 en /tmp/soundsible-s3b-dj-direction-intent-ui.log.

Controlador Media3 conservado NORMAL→DJ→NORMAL aceptado sobre working tree:
DJ HTTP/TLS2 + NORMAL2, todos verdes; normal APK/test/JVM49/lint pasan en
/tmp/soundsible-s3b-dj-session-controls-native.log. El mismo MediaController
observa metadata dominante y pausa/reanuda DJ antes/después de recrear Activity.
No prueba todavía focus/noisy de DJ, dispositivo/coche ni recuperación completa.

Regresión nativa completa sobre255d07b8 limpio: principal120/3, log
/tmp/soundsible-s3b-full-native.log. Fallan PlannerRetirement HTTP Radio/Autoplay
por asumir que primer candidato es member-radio-* y ProgramPcm HTTP por buscar
member-track fuera de filas virtualizadas. Fixes: seleccionar candidato propio
dentro del plan real y buscar canción por UI. Dirigido retiro4+PCM2 pasan en
/tmp/soundsible-s3b-focus-retirement-pcm-fixed-native.log; ese mismo run DJ2 falla
porque broadcast noisy enviado por shell no alcanza receiver NOT_EXPORTED.
No presentar120/0 ni restart actualizado: el fallo principal impide fases restart.
DJ HTTP/TLS2/0 con pérdida temporal de focus real y noisy simulado por UID sistema
en AVD rooteado aceptado; APK/test/JVM49/lint normal pasa, log
/tmp/soundsible-s3b-dj-system-focus-native.log (dirty=true). No acredita auriculares
físicos. Los scripts de integración exigen AVD; este caso además requiere su.
Recuperación saliente sin ventana aplicada: si la entrada actual falla y la
sucesora tiene PCM preparado, el controller la promueve por corte directo.
ProgramDjRecoveryTest usa controller real, HTTP404 en decoder y PCM sucesor
48k/estéreo no silencioso. HTTP/TLS2/0 y normal APK/test/JVM49/lint pasan en
/tmp/soundsible-s3b-dj-outgoing-direct-pcm-native.log (dirty=true). El caso usa
mixing=false para asegurar ausencia de ventana armada; no acredita aún caída
de red durante mezcla comprometida ni su starvation. Es prueba del controller
de producción aislado, no del flujo bridge/servicio completo.
El fallo real TLS al cerrar conexiones SSL en hilo principal está corregido:
pool/dispatcher de audio propios, retiro en worker y shutdown de su executor.
Ver evidence/s3b.json. DJ/Live/Auto/Settings restantes/firma/update
siguen pendientes; continuar hasta paridad sin cerrar por slice. Después dejar
PR abierta con checks pasando para review manual, sin merge ni automerge.
No publicar release antes de revisión y merge; preparar información de alpha.
Browser4 final debe repetirse antes de abrir PR.

Preferencia «Mezcla DJ» conectada a Core mediante PATCH/GET confirmado, cache
por perfil y estado nativo publicado a Settings. Comparte el worker de preferencias
de audio con leveling; no comparte su valor ni sus comandos. Desactivar mezcla
conserva una transición ya preparada y aplica DIRECT/duración completa a las
siguientes. DJ2 + PCM2 HTTP/TLS pasan junto con APK/test/JVM49/lint normal en
/tmp/soundsible-s3b-mixing-settings-native.log (dirty=true sobre12a872d0).
La prueba verifica duración completa y ausencia de PCM mezclado con mezcla off,
y vuelve a activar antes de refill. UI198 archivos/1557 tests y TypeScript pasan
en /tmp/soundsible-s3b-mixing-settings-full-ui.log. Restart offline sobre12a872d0
limpio pasa prepare1 + force-stop/offline1, con build normal posterior en
/tmp/soundsible-s3b-restart-offline-native.log. No reemplaza la principal120/3:
regresión completa actual y browser4 siguen pendientes. Siguiente: recuperación
acotada de PCM ausente durante transición comprometida; no declarar paridad DJ.

ProgramTransport muestra estados observados del planner: planning/warming,
degraded (transiciones pendientes), exhausted y errores terminales. Los controles
siguen ligados al programa actual; ready limpia feedback anterior. Dirigido14/0
y TypeScript pasan en /tmp/soundsible-s3b-dj-phase-{ui,typecheck}.log. Esta UI
se añadió después de preparar el artifact starvation; no atribuirle aceptación
APK de ese run. Regresión browser4 permanece pendiente antes de PR.

Recuperación acotada durante mezcla aceptada: ProgramDjRecoveryTest6/0 HTTP/TLS,
APK/test/JVM49/lint normal sin CA en /tmp/soundsible-s3b-starvation-ramp-fixed-native.log.
Retira una entrada que deja de suministrar PCM durante2s si la otra tiene audio;
pausa no consume el timeout. Conserva epoch/reloj y prueba PCM48k estéreo no
silencioso DESPUÉS de la rampa. Caso del controller real aislado, sin demostrar
todavía una descarga de red detenida en el flujo bridge/servicio. Asset prepare
sobre0f26f348 dirty=true; fuentes finales dirty sobre1ab49ea6. No afirmar principal
completa verde ni paridad DJ. /tmp/soundsible-s3b-starvation-post-recovery-pcm-native.log
conserva una carrera real encontrada: el controller rearmaba antes de acabar
la rampa. Ahora exige fin de rampa renderizada y reloj físico, y retirar el decoder
no inicia otra restauración. Si faltan AMBAS entradas no hay audio sano que
recuperar; este caso no está cubierto por este watchdog.

Los apartados de entrega siguientes son históricos; usar el último y PORT_PLAN
para saber qué falta. S2s conserva audio/ID al editar metadata/sidecar; S2t añade
bookmarks sobre entidades adquiridas y refresh confirmado. Los fallos encontrados
en regresión (refresh Saved y presupuesto auth compartido) están corregidos.
Última APK principal: **73 tests + dos fases offline persistentes pasan**, sources
preparados desde commit limpio46a6c3d; APK/test APK/JVM20/lint normales pasan
sin CA temporal. Log /tmp/soundsible-s2af-main-clean.log.
Últimos browser completos S2ad: Chromium278/66 y WebKit269/75, sin fallos,
secuenciales con1worker como CI, incluida Apariencia/cabecera/enlaces. Repetir cuatro perfiles antes del PR final.
S2u selector OS y S2v prioridad de sidecar validados; S2w letras adquirido/preview
usa panel compartido con runtime nativo y pasa HTTP/HTTPS. Faltan biblioteca/
Discover/Settings completos, DJ, Live, Android Auto, firma y actualización.
S2x adquisición y S2y importación compartida/selector DocumentsUI HTTP/HTTPS
validados. S2z navegación Atrás validada con conservación de programa/sesión;
continuar sin cerrar por slice. Primera principal sobre 502947d: 45 casos,
un fallo en cerrar tras refill Radio. La primera corrección pasó Autoplay pero
falló Closure en la segunda principal (45 casos, dos fallos). Contrato final:
programToken estable durante refills, distinto al abrir una cola nueva; stop
valida identidad de programa + UID/generación, con guard de orden para callers
antiguos sin programToken. Closure y Autoplay HTTP/HTTPS (4 casos) y APK/test/unit/
lint normal sin CA temporal pasan. Repetir principal + dos fases offline antes
de sustituir el resultado anterior. Los archivos en
integration-results sólo se actualizan si pasa: no usar el antiguo XML de 35
como resultado de esta ejecución fallida. Próximo bloque:
[eliminar adquirido](SLICE_2AA.md).
No PR abierta para review manual todavía; mantener gates de alpha completa y continuar.

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
PR abierta con checks pasando para review manual; sin merge ni automerge.


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
PR abierta para review manual. No se ha publicado alpha parcial ni integrado a main.

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
Continuar hasta la paridad y después PR abierta para review manual autorizados; no finalizar por
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
seguir sin terminar el turno por un slice. PR abierta para review manual sólo al cerrar gates.

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
de matriz. No finalizar por checkpoint; PR abierta para review manual requieren paridad completa.

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
completa; ningún checkpoint termina autorización PR abierta para review manual tras paridad.

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
no implementación. Continuar sin finalizar por checkpoint hasta paridad y PR abierta para review manual.

Continuación activa S2r: formulario de metadata extraído sin stores/audio web y
adaptador Native REST, todavía sin conectar a programa/shell. Typecheck y tres
tests de presentación pasan; Native metadata/artwork y recorrido APK pendientes.
Estos archivos no pertenecen al APK de aceptación S2q ni al commit de autoplay.
Mantener commits separados y continuar hasta paridad/PR abierta para review manual autorizados.


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
S2q31 + restart2; browser S2j. No PR abierta para review manual hasta matriz completa; continuar
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
Continúa autorizado hasta matriz completa, PR abierta para review manual; no finalizar por slice.


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
Continuar hasta paridad completa; PR abierta para review manual siguen pendientes.


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
Continuar hasta todos los gates de paridad, luego PR abierta para review manual autorizados.


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
No cerrar por slice; continuar hasta PR abierta para review manual de paridad completa.


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
No cerrar por slice; continuar hasta paridad completa y PR abierta para review manual autorizados.


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
PR abierta para review manual autorizados. No finalizar por slice.


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
No cerrar turno por slice ni publicar antes de paridad; PR abierta para review manual después.

## Continuación S2aa: eliminación y filesystem recuperable

Implementación conectada y aceptación base en [SLICE_2AA](SLICE_2AA.md).
UI completa 1.465/172 pasa; JVM explícito17 y backend lifecycle12 pasan. Cuatro
casos nativos HTTP/HTTPS base pasan: retirada duplicada local con preview/keys/
pausa20s preservados, referencias de playlist, pool de otro owner, sucesor,
cierre de última fuente y error filesystem con recuperación desde gestor.
Extensión de copia borrada por otro cliente validada HTTP/HTTPS: conjunto final4
pasa en /tmp/soundsible-s2aa-progress-native.log, APK/test APK/JVM17/lint pasan sin
CA temporal. Assets37d1669 dirty=true. Corregido progress.value=undefined que
abortaba render de gestor en WebView mientras no había tamaño conocido; prueba
estricta reproduce fallo anterior. No purgar automáticamente copias por membership remoto.

Corrección de evidencia: las ejecuciones antiguas que sólo ensamblaban APK de
tests y generaban lint unit models no acreditan ejecución JVM. La ejecución
explícita17 sí; el helper ahora añade testDebugUnitTest al cierre normal sin CA.
Preparar commit limpio y repetir principal ampliada49 + dos fases offline;
no sustituir el verde histórico35 por XML antiguo ni por targeted4. Continuar
sin cerrar por slice hasta paridad completa y PR abierta para review manual autorizados.


## Principal limpia S2aa

Assets desde dc29b73, dirty=false: principal49, cero fallos/errores/omisiones;
prepare1 + force-stop/offline1 pasan en el protocolo persistente. APK normal,
test APK, JVM17 y lint pasan tras retirar la CA temporal. Log
/tmp/soundsible-s2aa-main-clean.log, XML actual android/build/integration-results.
Este resultado sustituye el histórico35+2, no los fallidos45 de S2z.

Durante esta ejecución se prepararon fixture/draft [S2ab](SLICE_2AB.md), sin
cambiar código nativo ni assets de dc29b73. La corrección posterior de recuperación
local (restoreOffline(false), conservar biblioteca online) está pendiente de
instrumentación específica; no atribuirla al artifact limpio anterior. UI1465/172
pasa en /tmp/soundsible-s2aa-online-recovery-ui.log. Próximo: incorporar draft
PlannerRetirementTest y comprobar HTTP/HTTPS Radio/autoplay, junto a la nueva
assertion de biblioteca conectada en OfflineRemovalTest. Continuar luego resto
paridad; PR abierta para review manual aún pendientes.


Recuperación local posterior validada: restoreOffline(false) actualiza estado de
copias conservando biblioteca conectada. Native HTTP/HTTPS exige no mostrar
station inaccesible ni perder preview guardado tras error de filesystem; dos
casos dentro de targeted6 pasan (/tmp/soundsible-s2ab-native.log), assets4e04083
dirty=true. UI1465/172 y APK/test APK/JVM17/lint normales sin CA pasan. No equivale
a nueva principal limpia. S2ab cuatro casos del mismo conjunto también pasan;
registrar su entrega aparte y continuar paridad restante.


## S2ab: respuesta real pendiente descartada

[Contrato/evidencia](SLICE_2AB.md). Fixture retrasa una respuesta ya calculada,
no altera cuerpo del planner; delay cooperativo gevent y control loopback/header,
acotado5s/una llamada. Python WAV/FLAC2 pasa. Native4 HTTP/HTTPS Radio/autoplay
pasan en /tmp/soundsible-s2ab-native.log (targeted6 con OfflineRemoval2), assets
4e04083 dirty=true. DELETE confirmado durante pending; respuesta vieja entregada,
refill nuevo sin ID retirado; conserva key/programToken/pausa20s y modos. Cleanup
restaura preferencias y fuentes sintéticas, drena delay antes del próximo caso.
APK/test APK/JVM17/lint normales sin CA pasan. Principal53+restart2 pendiente;
última limpia dc29b73 49+2. Continuar Settings/Discover/biblioteca restantes,
DJ/Live/Auto/firma/update y después PR abierta para review manual; no finalizar por slice.


## Principal limpia S2ab

Assets03e3446 dirty=false: principal53, cero fallos/errores/omisiones, más dos
fases persistentes offline prepare/force-stop/offline. APK normal/test APK/JVM17/
lint sin CA pasan en /tmp/soundsible-s2ab-main-clean.log. Archive actual en
android/build/integration-results. Sustituye principal49 de dc29b73. Durante la
regresión sólo avanzaron fuentes UI de [Settings S2ac](SLICE_2AC.md), sin tocar
fuentes nativas ni assets del artifact limpio. UI1481/175 pasa; Settings aún
requiere recorrido instrumentado HTTP/HTTPS y aceptación de sesión rotada.
Continuar sin detenerse por slice hasta paridad completa y PR abierta para review manual.


## S2ac: Cuenta compartida e historial por perfil

AccountSettingsView y SearchHistoryStorage reutilizados por web/Android sin stores
de audio. Mutaciones confirman receipt y snapshot dentro de scope cancelable;
logout respeta busy de revalidación. Native HTTP/HTTPS2 pasa: ediciones canceladas
y rechazadas, perfil confirmado, password/cookie cifrada rotada y descifrada por
nueva conexión, reconexiones reales de eventos, conservación de keys/programa/
pausa20s/copia y Activity, logout confirmado y nuevo login con credenciales nuevas.
Owner/member conservan preferencias de historial independientes.

UI1484/176 y APK/test APK/JVM17/lint normales pasan. Assets06004af dirty=true;
principal55+restart2 limpia pendiente, último artifact limpio03e3446 tiene53+2.
Regresión completa de navegador aceptada: Chromium278/66 y WebKit269/75,
sin fallos; consultar SLICE_2AC/evidence/s2ac.json.
Fallos iniciales de localizador username y logout durante revalidación corregidos
y archivados; no reutilizar sus resultados como verdes.

Continuar Appearance/accesibilidad según SLICE_2AD, después Settings/Discover
restantes, DJ/Live/Auto y firma/update. No PR abierta para review manual todavía; no cerrar por
slice. Gates de alpha completa vigentes.


## S2ad: Apariencia validada en Android, regresión compartida pendiente

Principal55 sobre aad83d4 dirty=false encontró un fallo OfflineTest TLS al
reanudar después de la segunda recreación. Replay original HTTP/TLS2 pasa;
el helper ahora espera botón habilitado y UI fuera de boot. No sustituir la
principal limpia53+restart2 de03e3446 hasta repetir principal57+restart2.

Apariencia implementada en fuentes: seis temas, SystemBars de Capacitor para
contraste de iconos, puente limitado para fondo de ventana, cambios reales del
modo noche del SO, idioma, tamaño y contraste. Native HTTP/TLS2 pasa, conserva
programa/pausa20s/copia/sesión en Activity y offline503. APK/test APK/JVM17/lint
normales sin CA pasan. UI1489/179 serial pasa. Evidencia en SLICE_2AD y
 evidence/s2ad.json; no atribuir aceptación física al emulador.

Regresión Chromium encontró título pulsable de cabecera menor de44px al medir
todos los controles; corregido min-height44px. Test mide fila en un mismo frame.
Enlaces Ctrl-click esperan geometría estable y nueva pestaña con fixture de
contexto/foreground. Dirigido Chromium28 pasa/20 omitidos; cuatro perfiles
completos pendientes. Último serial anterior268 pasa/66 omitidos/10 fallos;
no considerar verdes ni ese run ni sus predecesores parciales.

Continuar sin cierre de slice: terminar regresión cuatro perfiles, commit/push,
preparar artifact limpio y principal57+restart2. S2ae Discover inventariado en
SLICE_2AE; Settings restantes, DJ, Live, Auto y firma/update siguen pendientes.
Gates de alpha completa vigentes; PR abierta para review manual sólo al cumplirlos.


## Regresión completa S2ad aceptada

Chromium278/66 y WebKit269/75, cero fallos, los cuatro perfiles completos
secuenciales con1worker como CI. Logs /tmp/soundsible-s2ad-{chromium,webkit}-ci-worker.log.
Popup real mantiene Ctrl-click/foreground, espera DOMContentLoaded y ficha
completa; ocho repeticiones con trace pasan. Con8workers un caso queda esperando
URL incluso tras readiness DOM; no declarar esa ejecución verde. S2ae durante
los runs sólo cambió Native y añadió vistas compartidas aún sin conectar; las
entradas web medidas permanecieron iguales. UI completa con bases S2ae se repite
antes de preparar artifact limpio/principal57+restart2. No paridad ni alpha.

UI completa1504/185 pasa en /tmp/soundsible-s2ae-foundation-full-ui.log sobre
dc841c9 (docs de evidencia pendientes sólo). Todo entregado se mantiene en
feat/android-port-foundation; S2ae aún sin pantallas all/feed/fichas reales.
Preparar artifact limpio después de guardar esta evidencia; congelar Native y
assets durante principal57+restart2. Se puede avanzar UI S2ae después de prepare,
pero no volver a preparar ni tocar fuentes/tests nativos durante el runner.


## Principal limpia S2ad y UI S2ae en desarrollo

8329de5 dirty=false: principal57, cero fallos/errores/omisiones; restart prepare1
y force-stop/offline1 pasan. APK normal/test APK/JVM17/lint sin CA pasan en
/tmp/soundsible-s2ad-main-clean.log. Sustituye la principal53 aceptada; no borra el
diagnóstico55 aad83d4 fallido. Fuente Native y assets permanecieron congelados.

UI S2ae posterior NO incluida en ese artifact: vistas web de Discover/discografía
ya delegan a layouts puros; Android feed/canciones-artistas-álbumes/fichas con
candidates/related/discografía y Play/shuffle de colección conectados en fuentes.
Menú de canciones resueltas reutiliza songMenu de Library, incluido offline dentro
de menú. UI dirigida26/7 pasa /tmp/soundsible-s2ae-connected-ui.log. Estado dirty
en rama: descargas/review de colección aún en implementación, nuevos layouts
requieren suite UI/cuatro perfiles y Android HTTP/HTTPS propios. No paridad S2ae
ni release aún. Congelación Native anterior levantada al acabar runner0.

### Continuación S2ae: pantallas y colecciones conectadas, validación pendiente

Ver SLICE_2AE: vistas Discover/Artist conectadas en web y Android; navegación
reversible, búsqueda de cuatro tipos, cola nativa y controller de jobs confirmado.
UI1516/187 y fixture Core1 pasan. Nuevas seis pruebas de controller pasan.
Chromium en curso (/tmp/soundsible-s2ae-chromium.log), luego WebKit. Integración
HTTP/TLS dirigida en curso (/tmp/soundsible-s2ae-profile-native.log), artifact
preparado dirty de desarrollo. No aceptar Native S2ae ni reemplazar principal57
hasta resultados. Fuentes nativas/fixtures/assets congeladas durante ese run.
Adquisición/revisión de colección end to end todavía pendiente; no PR/release.

S2ae update: Chromium278/66 pasa. Primera Native dirigida4fallos: fixture-ID y
regresión de save/remove en previews; ambos corregidos, pytest1 y dirigido18/2
pasan. Nueva Native dirigida /tmp/soundsible-s2ae-profile-native-fixed.log en
curso; no aceptar hasta resultados. WebKit /tmp/soundsible-s2ae-webkit.log sigue
en curso. SLICE_2AF inventaría siguientes Settings y exige efecto real del DSP,
no switches cosméticos. Mantener continuidad hasta todos los gates autorizados.

S2ae aceptación dirigida final:6/0 HTTP/TLS en
/tmp/soundsible-s2ae-final-directed-native.log; XML integration-targeted propio,
principal57/restart2 conservado. APK normal/test/JVM17/lint pasan sin CA temporal.
UI1522/188, fixture Core1 y browser4 278/66+269/75 pasan. Core adquiere archivo
con metadata y reproduce fuente local al nuevo Play; Atrás restaura consulta y
scroll real. Review/cancel/retry Core y adquisición sin preview anterior siguen
pendientes. Ver último apartado SLICE_2AE; seguir sin cierre de turno por slice.

### Revisión y feedback Android aceptados; siguiente aceptación Settings

/tmp/soundsible-s2ae-review-links-native.log:16/0 HTTP/TLS,14 review/profile/search
más2 feedback; APK/test APK/JVM17/lint normales pasan sin CA temporal. Adquisición
sin Save/preview anterior enlaza identidad confirmada del job con el archivo local
sin crear guardados. El primer run review falló4 y se conserva como diagnóstico;
la repetición confirma elegir versión/skip/cancel/retry reales. Feedback usa View
sin permiso VIBRATE ni flags para ignorar al sistema; on/off persiste en Activity,
rechazo del SO no toca programa/sesión. No aceptación de sensación física.

Learning y diagnóstico UI añadidos DESPUÉS del prepare de ese artifact; no confundir
con su aceptación Native. Controller confirma PATCH/GET, reset DELETE confirmado,
scope cancelable; diagnóstico sólo mide lo que entrega el motor, desconocido ante
fallo/desconexión. Dirigidos Learning4 y diagnóstico2 pasan. Repetir UI completa,
preparar nuevo artifact y probar Core HTTP/TLS. Falta regresión browser4 de nuevas
vistas antes del PR y principal limpia ampliada con restart2. Última principal
limpia sigue8329de5 57+2. Continuar Settings pendientes, DJ/Live/Auto/firma/update,
commit/push y finalmente PR abierta para review manual con paridad completa. No cerrar por slice.

Settings6 aceptados en /tmp/soundsible-s2af-settings-recovery-native.log; normal
APK/test APK/JVM17/lint y retiradaCA pasan. Learning off impide eventos, Cancel
no envía DELETE, reset real borra member y conserva owner, Activity mantiene
preferencia y503 usa offline/Retry general sin defaults inventados. UI1534/192
pasa; Browser4 siguiente. Settings Playback Autoplay Native tiene vista/pruebas
preparadas, aún sin ruta ni aceptación APK. Última principal limpia sigue57+2;
preparar limpia ampliada73+2 después de commits. DSP/otros Settings/DJ/Live/Auto/
firma/update siguen pendientes. Continuar hasta PR abierta para review manual autorizado.

### Autoplay Settings confirmado y regresión compartida cerrada

/tmp/soundsible-s2af-autoplay-native.log termina0:10 casos HTTP/TLS, Autoplay2
ampliado con Settings, Closure2 y Learning/Feedback/Appearance6. APK normal/test
APK/JVM20/lint pasan, CA temporal retirada. Programa y preferencias sobreviven
Activity; toggle cambia refill/retirada real. UI1536/192 pasa. Browser4 completo
Chromium278/66 y WebKit269/75 sin fallos, secuencial1worker y readonlyWebKit.
Fuentes web de esos recorridos permanecieron iguales durante ambos runs;
Autoplay Native posterior y test de loudness no cambian la entrada web.

ProgramLoudness y shared/contracts/loudness_gain.tsv son base de regla S3a;
TS38 y JVM3 pasan. Sin AudioSink/tap PCM ni leveling/mixing entregados aún. Ver
SLICE_3A. Próximo paso inmediato: commit/push, preparar commit limpio y principal
73+restart2 con Native/tests/fixtures/assets congelados hasta normal build.
No reemplazar todavía el último principal limpio57+2. Durante esa regresión
puede avanzar UI futura no preparada de Subsonic/otros Settings, pero no fuentes
nativas ni fixture ni recursos de pruebas del artifact. Después S3/DJ/Live/Auto/
firma/update y PR abierta para review manual autorizado. No cierre por slice.

### Continuación S2ag durante principal limpia S2af

Principal73 sobre46a6c3d dirty=false está en curso; no sustituir todavía57+restart2.
Fuentes/tests Native, fixtures, recursos JVM y assets permanecen congelados hasta
acabar ambas fases restart y build normal. UI posterior de Subsonic no pertenece
al artifact en ejecución. SLICE_2AG documenta contrato y aceptación pendiente.

Extracción de vista compartida y controlador scope/confirmación pasan21 tests
conectados en5 archivos, typecheck correcto, log
/tmp/soundsible-s2ag-connected-ui.log. Dos diagnósticos anteriores de screen tests
fallaron por labels incorrectas y por montar con && fuera de Show reactivo;
corregidos con labels reales y montaje/desmontaje real. Ruta Android conectada,
adapter JS clipboard pendiente de plugin nativo y aceptación HTTP/TLS. No marcar
Subsonic end to end aún; no afirmar cobertura browser4 de esta nueva extracción.
Continuar principal, commit/push de evidencia aceptada y plugin/pruebas Subsonic,
después DSP/DJ/Live/Auto/firma/update y PR abierta para review manual. No cerrar por slice.

### Principal limpia S2af aceptada

46a6c3d37793c4b49f94d372e6b5e9287baed039 dirty=false: principal73/0,
restart prepare1/0 y force-stop/offline1/0; APK normal/test APK/JVM20/lint pasan
sin CA temporal. Runner /tmp/soundsible-s2af-main-clean.log termina0. XML actual
integration-results confirma73 y los dos result.json confirman1+1. Sustituye
principal57; no atribuir Subsonic posterior a este artifact. Congelación Native
levantada al terminar runner. Continuar S2ag end to end y DSP/DJ/Live/Auto.

### Subsonic S2ag Native dirigido aceptado

/tmp/soundsible-s2ag-account-fixed-native.log termina0 con4/0 HTTP/TLS:
Subsonic2 ampliado y Account2, APK normal/test APK/JVM20/lint sin CA pasan.
Mint/replacement/revoke cambian auth real formPOST/rest, copias OS con sensitivity,
Activity sin contraseña, cambio member-owner confirmado sin estado ajeno ni
secretos; programa/keys/pausa/sesión intactos antes del logout explícito. El
primer dirigido2 también pasa; la primera ampliación4 falla2 por elegir Sign out
de cabecera, se conserva diagnóstico y el locator de Cuenta se corrige.
UI1547/195 pasa. Browser4 de vista compartida Subsonic siguiente/en curso; última
principal limpia sigue73+restart2 sobre46a6c3d. Congelación Native levantada.
Continuar DSP S3a y Settings restantes, DJ/Live/Auto/firma/update. No alpha aún.

### Regresión browser4 S2ag aceptada y DSP en fuentes

Chromium278/66 + WebKit269/75, cero fallos, suites completas secuenciales1worker,
readonlyWebKit; logs /tmp/soundsible-s2ag-{chromium,webkit}.log. Vite propio
detenido. UI web no cambió durante los runs. Cambios DSP sólo Native y docs,
aún sin compilar/probar; ver SLICE_3A. No preparar ni ejecutar Gradle pesado
durante browsers. Ahora compilar processor/kernel/tap y worker Core confirmado;
conectar Native Track/contexto/Settings y demostrar PCM real antes de aceptar.
No cerrar por S2ag: Settings restantes, DJ/Live/Auto/firma/update/PR abierta para review manual
continúan autorizados, alpha de paridad completa únicamente.


## Snapshot de continuidad 2026-10-06: dcdd6a3b, regresión en curso

# Traspaso del port Android

## Decisiones vigentes

- Rama `feat/android-port-foundation`; todo entra a main mediante PR.
- Completar paridad de teléfono, DJ, Live y Android Auto antes de alpha. Los
  artifacts debug son de desarrollo y no acreditan una release.
- Hacer commit/push de implementaciones validadas. Al completar paridad, dejar
  **PR abierta con checks pasando para review manual**. **No merge, automerge
  ni release** antes de revisión y merge del usuario. Preparar instrucciones alpha.
- Offline B aprobado: música adquirida, copias explícitas, «Disponible sin
  conexión» sólo en menús de tres puntos; sin preparación en shells ni autoevicción.
- UI Solid compartida con adaptadores nativos. La app iOS es Swift independiente;
  no describirla como un port Solid sincronizado. Mantener aviso PAL no verificado.
- No hay Android físico del usuario. AVD/PCM/CI no acreditan escucha, auriculares,
  Bluetooth ni coche real. Gates físicos completos para beta, según RELEASE_GATES.
- Trabajar hasta paridad, sin cerrar por slice. Usar dirigidos durante fixes y
  suites completas al cerrar bloques. No delegar sin autorización.

## Estado actual

Últimos bloques validados: recuperación de PCM detenido durante mezcla DJ
(`0b070887`) y DJ → Radio conservando canción/posición/pausa. `0f26f348` añadió
preferencia de mezcla confirmada y `1ab49ea6` feedback observado del planner.
No hay paridad completa ni PR final todavía.

- Teléfono: NORMAL, podcasts, Radio/Autoplay, biblioteca/colecciones/bookmarks,
  adquisición/review/importación, metadata, letras, Cuenta/Apariencia/Feedback/
  Learning/Subsonic y offline tienen verticales validados. Ver PORT_PLAN para
  acciones restantes; compartir/multidispositivo y Settings restantes no cerrados.
- DSP S3a: leveling y captura post-DSP/pre-volumen, PCM y preferencia por perfil.
  Principal limpia78/0 sobre `d049f404`; es anterior a DJ.
- DJ S3b: Core real, dos decoders normalizados a estéreo48k, un AudioTrack,
  siete técnicas/FX, metadata dominante, pausa/background, apertura contextual y
  desde fuentes, perfiles/dirección, edición, refill efectivo y replan de futuro,
  controles MediaSession/focus/noisy en AVD, retorno NORMAL y mezcla off confirmada.
  Recuperación de decoder previo a mezcla y de una entrada sin PCM durante mezcla
  aceptadas con controller real aislado. Reparación Core, pins al replanear y estado
  «Preparada» y placement musical aceptados. Refinamiento previo a preparación conectado y recuperación de una entrada
  con body pendiente validada en servicio. Ambas entradas indisponibles pendientes. No declarar paridad DJ.
- Live y Android Auto: pendientes. Firma permanente/update público: pendientes.

## Evidencia que importa al continuar

- Regresión completa **130/0** sobre `d7e95c44` preparado limpio,
  `/tmp/soundsible-s3b-regression-native.log`; restart prepare1/offline1 y normal
  APK/test/JVM52/lint pasan. Runtime instrumentado1835.188s. Es anterior al bloque
  network/settings descrito abajo; no equivale a paridad completa.
  Histórica120/3 en `soundsible-s3b-full-native.log`; correcciones incluidas en130.
- Recuperación DJ6/0 HTTP/TLS + APK/test/JVM49/lint normal sin CA:
  `/tmp/soundsible-s3b-starvation-ramp-fixed-native.log`. PCM no silencioso después
  de rampa, pausa excluida del timeout, epoch y reloj retenidos. Asset prepare
  `0f26f348` dirty; fuentes finales dirty sobre `1ab49ea6`. El diagnóstico anterior
  `starvation-post-recovery-pcm-native.log` encontró rearming antes de acabar rampa;
  corregido con guard de render + reloj físico. No cubre ausencia de ambas entradas
  ni descarga detenida en el flujo bridge/servicio.
- Mezcla off DJ2+PCM2/0, normal APK/test/JVM49/lint:
  `/tmp/soundsible-s3b-mixing-settings-native.log` (dirty sobre `12a872d0`).
  Canciones completas; una transición ya preparada conserva su decisión.
- Restart offline limpio `12a872d0`: prepare1 + force-stop/offline1 y build normal,
  `/tmp/soundsible-s3b-restart-offline-native.log`.
- DJ → Radio: DjProgramTest2/0 HTTP/TLS, APK/test/JVM49/lint normal sin CA,
  `/tmp/soundsible-s3b-radio-mode-native.log`. Mismo MediaController controla
  NORMAL → DJ → NORMAL/Radio; KEY, posición y pausa retenidos al salir de DJ.
  Artifact sobre `0b070887` dirty; fuentes finales dirty sobre `ba697dc4`.
  Incluye feedback UI del planner. Runtime completo158.6s, sin baseline comparable.
- Repair/pins/cued: DJ2 + Recovery6, **8/0 HTTP/TLS**, APK/test/JVM52/lint normal
  sin CA en `/tmp/soundsible-s3b-repair-native.log`, sobre `be2894fc` dirty.
  Core repara futuro de16; conserva requests por KEY y profundidad, incluido
  cambio efectivo de fuentes. Snapshot/epoch/revision/floor rechazan resultados
  obsoletos; inputs comprometidos no pueden retirarse/reordenarse. Insert after
  respeta floor. UI198/1561 + TS en `/tmp/soundsible-s3b-repair-full-ui.log`.
  No acredita todavía placement musical, refinamiento, todos los negativos de
  respuestas Core ni larga sesión hasta el límite de1000 ocurrencias.
- Placement: DJ2/0 HTTP/TLS, APK/test/JVM52/lint normal sin CA en
  `/tmp/soundsible-s3b-placement-native.log` sobre `cebf7246` dirty. `dj-place`
  calcula inserción/bridges/following transition; request user se conserva desde
  su aceptación.503 conserva fallback en cola; respuesta computada y demorada2s
  no revierte Move ni duplica petición. Cambio de fuentes conserva ambas requests,
  incluyendo dos ocurrencias del mismo recording. Controles de fixture anónimos
  sin header rechazados403. No prueba placement fijo lejano ni todas las variantes
  de bridges, refinamiento o larga sesión. UI198/1564 + TS pasa.
- UI completa: **198 archivos/1564 tests + TypeScript**, último log
  `/tmp/soundsible-s3b-placement-full-ui.log`.
- Browser4 último verde es anterior a S3: Chromium278/66 skips + WebKit269/75 skips,
  `/tmp/soundsible-s2ag-{chromium,webkit}.log`. Repetir los cuatro antes de PR.
- Evidencia durable: [S3a](evidence/s3a.json), [S3b](evidence/s3b.json).
  Resultados crudos locales en `android/build/integration-results` y carpetas
  dirigidas; no reemplazar la principal fallida por un dirigido exitoso.

## Trabajo activo y siguiente paso

Placement (`3c832ce9`) subido. Historial largo: Recovery8/0 HTTP/TLS y build
normal pasan sobre `3c832ce9` dirty; cola1000 recortada sin reset de audio,
append reteniendo KEY/posición/pausa/epoch, exclusión acotada de80 escuchadas.
Log `/tmp/soundsible-s3b-history-native.log`. Refinamiento conectado al Core antes de preparar decoder: Recovery8 + DJ2,
10/0 HTTP/TLS, APK/test/JVM52/lint normal pasan sobre `9bed92e6` dirty.
Log `/tmp/soundsible-s3b-refine-native.log`. Guards nativos aceptan proposal
no comprometida y rechazan snapshot obsoleto/cue preparada. Prueba adicional measured Core real2/0 HTTP/TLS, normal build pasa,
`/tmp/soundsible-s3b-measured-native.log` sobre `d7167176` dirty.
Consulta análisis real de archivos sintéticos; transición measured aplicada
con fromKey y outCue exactos antes de playback. Negativos restantes pendientes.
Continuar recuperación de red en servicio y restantes de paridad. Fixture DJ acota fallos/delays alrededor
del Core real; no sustituye sus respuestas válidas por un planner falso.
Regresión principal actual **130/0 + restart prepare1/offline1 + build normal**
pasa sobre `d7e95c44` preparado limpio:
`/tmp/soundsible-s3b-regression-native.log`, sesión exec78409 terminó exit0. Runtime instrumentado1835.188s.
Congelación principal levantada. Bloque network/settings validado en checkout `/tmp/soundsible-android-next`
sobre `c3d392d6` dirty y trasladado al principal sin cambiar sus fuentes:
- planner/refiner ligan memo y guards a settingsRevision; mismo par reconsultado
  tras cambiar perfil. Measured2 y NORMAL2 pasan en range-native (suite6/2 falla
  por fixture insuficiente; no reemplaza evidencia principal).
- Incoming stream entrega600000bytes (~3.125s), se detiene22s a través de Range,
  contador confirma body pendiente durante recuperación. Network2/0 HTTP/TLS y
  normal APK/test/JVM52/lint en `/tmp/soundsible-s3b-network-buffered-native.log`.
- MediaController.play tras503 prepara error temporal conservando KEY y PCM;
  sin reauth automática de401/403. No modifica UI ni datos del usuario real.
Diagnósticos: primer network-native6/1 falla callback WebView5s tras recreate en
NORMAL HTTP; repetición pasa NORMAL pero stall one-shot no es estable con Range.
Range-native6/2 muestra que64000bytes no arrancan decoder antes del bloqueo;
600000bytes y contador pendiente corrigen el fixture. No declarar éxitos de esos
runs fallidos ni recuperación si el bloqueo ya había terminado.

Principal/remote `acbd83d7` incluyen contrato car podcast, evidencia130 y
network/settings validados. Menús DJ desde canción/usar como fuente en validación
sobre ese HEAD dirty: UI198/1568 + TS pasan; Context2 + DJ2 nativo4/0 HTTP/TLS pasan,123.203s,
(`/tmp/soundsible-s3b-context-native.log`). Runner termina exit1 por lint del
borrador Auto no conectado (LibraryResult constantes antiguas). Corregido a
SessionError; build normal separado APK/test APK/JVM52/lint pasa
(`/tmp/soundsible-s3b-context-normal-build.log`), fuentes DJ sin cambios.
ProgramCarLibrary.kt nuevo está en desarrollo en principal; no integrado/validado
ni committed. Root HANDOFF/evidence se actualizan al cerrar network. Clone tiene
los mismos cambios network, no volver a copiarlos después de editar el principal.
Worktree falló ref nueva read-only; clone independiente funcionó. Commit/push sí
funcionan; no pedir acción al usuario. Mantener suites pesadas en serie; futuros
runs completos pueden usar checkout aislado para seguir editando otra copia.
Menú desde canción/usar como fuente validado: KEY/posición/pausa retenidos,
lead anterior retirado al cambiar contexto y requests explícitas retenidas.
Menús de ruta/cola con acciones de canción compartidas validados: Context2/0
HTTP/TLS, normal APK/test/JVM52/lint,19.962s instrumentados,
`/tmp/soundsible-s3b-route-menu-native.log` sobre `4f75ba17` dirty.
Eliminación por KEY preserva actual/posición/pausa; source existente seleccionado
y disabled. UI198/1570 + TS.
Placement fijo desde menú Add to route: Context2/0 HTTP/TLS, Core real coloca
ante KEY destino18 (más allá de horizon16), conserva KEY/posición/pausa.
Normal APK/test/JVM52/lint;22.075s instrumentados,
`/tmp/soundsible-s3b-fixed-placement-native.log` sobre `182a8dff` dirty.
UI199/1576 + TS. Selector sigue orden vigente del mismo programa; bloquea
destino retirado/comprometido y cambio de cuenta/programa.
Fuentes + ownership de bridges validados sobre `1eec3df3` dirty: Context2 +
Blocks2 + DJ2 + Recovery10 + Network2,18/0 HTTP/TLS;332.005s instrumentados;
normal APK/test APK/JVM54/lint, `/tmp/soundsible-s3b-owned-block-native.log`.
UI200/1581 + TS. Retirar fuente conserva petición/actual/pausa; última fuente
protegida. Bridge/owner viajan como bloque; un bridge audible protege a owner
y bridges pendientes, y placement/repair arrancan después del bloque comprometido.
Blocks2 suministra rows de ownership controladas a sesión de producción con
HTTP/TLS/decoders reales; no afirmar que el Core generó bridges en todos los casos.
Siguiente DJ: negativos restantes, ambas entradas indisponibles y larga sesión
hasta1000 en servicio/controller, luego regresión principal actual.

Teléfono S2ah: compartir canción integrado al principal y validado sobre
`23c5c416` dirty. Share2 + LibraryActions2 + DjContext2,6/0 HTTP/TLS,57.095s;
APK/test APK/JVM54/lint normal sin CA en `/tmp/soundsible-s2ah-share-native.log`.
UI201/1584 + TS. Selector nativo usa cápsula pública común o texto local/podcast;
Intent interceptado en tests, no entrega a destinatario ni prueba física.
Ver [S2ah](SLICE_2AH.md). Recepción/deep links/invites y multidispositivo pendientes.
Clone `/tmp/soundsible-android-next`, rama `feat/android-phone-continuation` sobre
`1eec3df3`: sharing ya copiado al principal; no volver a copiar archivos viejos.
Parser incomingTrack nuevo en desarrollo para cápsulas públicas/URL nativa open;
sin conexión automática ni autoplay. Native recepción implementada, en validación S2ai. Ver SLICE_2AI.md. UI204/1595 + TS pasan. Incoming2 + Share2 sobre 9450752c dirty compila; primer bloque4/2 detecta replay al recrear: BridgeActivity.load redespacha getIntent. Corregido en SharePlugin con descarte del despacho inicial restaurado; repetición en /tmp/soundsible-s2ai-incoming-recreate-native.log, no declarar aceptada hasta exit0 y build normal. Primer compile falló por nullable sólo en test, ya corregido. Fuentes congeladas durante runner. IncomingTrackTest limpia preferencias públicas pendientes al inicio/final.
Network viejo preservado en stash del clone; no aplicarlo sobre fuentes nuevas.

Android Auto: browse draft en ProgramCarLibrary, requiere integración, selección,
Radio, covers/offline y aceptación de host. Live y firma siguen pendientes.

En futuros runs, **congelar fuentes/tests Native, fixtures, assets y recursos
hasta final del runner, incluido build normal sin CA**. No atribuir un run a
fuentes cambiadas después de su prepare.

Después: cerrar refinamiento DJ, negativos restantes y larga sesión,
recuperación de red en producción y regresión completa; continuar Live receptor/
emisor, Android Auto, restantes de matriz de teléfono y firma/update. Gate final:
paridad + checks + PR abierta para review manual; nunca merge automático.

## Cómo trabajar sin repetir todo el historial

Leer [PORT_PLAN](PORT_PLAN.md), [RELEASE_GATES](RELEASE_GATES.md),
[arquitectura](ARCHITECTURE.md), [offline](OFFLINE_DECISION.md) y el slice pertinente
([S3b](SLICE_3B.md) ahora). El [historial](HANDOFF_HISTORY.md) conserva todos los
avances, fallos y comandos antiguos; consultar sólo el bloque relevante.

- Seguir AGENTS: nada de npm run build en ui_web, versión central, rama y commit,
  browser4 completo antes de PR, fetch/ancestry remoto actual e impact label único.
- JDK21: `/home/arsu/.cache/soundsible/android-toolchain/jdk/jdk-21.0.12.1+1`;
  SDK: `/home/arsu/.cache/soundsible/android-toolchain/sdk`. Exportar JAVA_HOME,
  ANDROID_HOME y añadir sus bin al PATH. Gradle sólo targets `:app:*`.
- Preparar con `.venv/bin/python scripts/android.py prepare`; integración con
  `scripts/android.py integration`, dirigido mediante
  `ORG_GRADLE_PROJECT_android.testInstrumentationRunnerArguments.class`.
  `integration --offline-restart-only` se ejecuta sin filtro de clase.
- Suites pesadas secuenciales. Chromium antes de WebKit readonly, un worker, como
  AGENTS. No tocar el motor personal. Fixtures dedicados5097/5098/5099 y cuenta
  sintética; no registrar cookies/credenciales reales ni exception messages secretos.
- No asumir API PCM externa en un AAR WebRTC: SamplesReadyCallback no es inyección.
  Investigación Live inicial sin implementación/dependencia elegida: upstream
  JavaAudioDeviceModule usa AudioRecord; setter AudioRecordDataCallback en fuentes
  GetStream consultadas no se pasa al constructor. Probar inyección de programa
  sin micrófono y recepción independiente antes de integrar salas/claim de emisión.
  Fuentes consultadas: [ADM upstream](https://webrtc.googlesource.com/src/+/main/modules/audio_device/g3doc/audio_device_module.md),
  [JavaAudioDeviceModule GetStream](https://github.com/GetStream/webrtc-android/blob/main/stream-webrtc-android/src/main/java/org/webrtc/audio/JavaAudioDeviceModule.java).

S2ai recepción validada sobre9450752c dirty: Incoming2 + Share2,4/0 HTTP/TLS,
29.504s, normal APK/test APK/JVM54/lint sin CA pasa (runner exit0).
Log /tmp/soundsible-s2ai-incoming-recreate-native.log. UI204/1595 + TS.
Recreate no reejecuta intent consumido; nuevos VIEW/SEND conservan KEY/posición/pausa
hasta Play explícito. Primer compile nullable y siguiente4/2 replay corregidos,
no contar esos runs como verdes. SLICE_2AI/evidence/s2ai.json guardan límites:
puente público/App Links, offline cached-match, invites/multidispositivo pendientes.
Congelación levantada. Siguiente DJ: ambas entradas indisponibles en Recovery.

DJ ambas entradas PCM: Recovery2/0 HTTP/TLS sobre450b207d dirty,
46.949s; normal APK/test APK/JVM54/lint sin CA pasa. Log
/tmp/soundsible-s3b-both-inputs-native.log. Ambos decoders pausados durante overlap
>2s: ninguna retirada sin contraparte sana; al volver outgoing hay recuperación,
PCM48k no silencioso y epoch/reloj retenidos. No prueba fallo permanente de ambas
fuentes de red. Pendientes negativos Core y cola1000 en servicio/controller.

S2ai offline terminado: sobref0e02058 dirty Incoming2/0 HTTP/TLS,19.214s;
normal APK/test APK/JVM54/lint sin CA pasa, UI204/1595 + TS.
/tmp/soundsible-s2ai-incoming-offline-confirmed-native.log. Copias nuevas guardan
youtube_id validado y recepción resuelve copia completa con APIs503. Copias viejas
sin identidad deben prepararse de nuevo para matching. Intentos previos sin AVD
y compile del test por API OkHttp obsoleta no son evidencia funcional; corregidos.
Fuentes descongeladas; AVD reiniciado headless sigue conectado. Próximo cola1000
DJ mediante servicio/controller; después negativos Core y regresión actual.

Cola larga servicio/controller validada sobre6bd23fc4 dirty: DJ2/0 HTTP/TLS,
23.115s; APK/test APK/JVM54/lint sin CA pasa, runner exit0.
/tmp/soundsible-s3b-service-history-native.log. Core DJ real + append hasta1000,
MediaController seek996/6000ms, recorte a4 preserva KEY/token/posición/pausa,
append a5 y resume PCM48k no silencioso. Es stress acotado mediante seek, no
1000 canciones naturales ni soak de días. Fuentes descongeladas. Siguiente:
negativos Core/refiner y regresión principal actual; Auto/Live/teléfono/firma pendientes.

Regresión principal actual en curso sobredcdd6a3b (tracked clean; incluye draft
ProgramCarLibrary no conectado/no committed): /tmp/soundsible-android-dcdd-regression-native.log,
sesión exec62863,144 tests. Congelar root Native/UI assets/fixtures hasta runner
final incluido build normal. No declarar resultado hasta exit final.
Checkout aislado /tmp/soundsible-auto-next, feat/android-auto-continuation,
clonado dedcdd6a3b. Source Auto en desarrollo allí: ProgramCarLibrary tree scoped,
PlaybackService browse/getItem/setMediaItems de IDs publicados, ignora URI/metadata
cliente, normaliza podcast y Radio. Futures pendientes terminan al reset/close;
401/403 distinguidos. Árbol offline desde copiasready, fallbackroot sólo con
copias reales. CarLibraryTest nuevo usa MediaBrowser real HTTP/TLS para árbol,
ID desconocido/otra cuenta, URI/metadata forjada y reproducción/PCM/account reset.
Sin compile/run todavía: ejecutar después de terminar regresión para evitar
suites pesadas en paralelo. Root draft Auto antiguo NO copiar sobre clone nuevo.
Pendientes Auto: validar APIs/signaturas/tests, subscriptions, artwork seguro,
Radio/podcasts/offline aceptación, descriptor Automotive y host/DHU. No afirmar
host Auto probado por MediaBrowser sameUID. Fuente oficial:
https://developer.android.com/media/media3/session/serve-content.
AVD headless exec76258; necesario mantenerlo vivo para suites restantes.

Regresión dcdd en curso encontró CatalogSearchTest HTTP: selector de menú global
por aria-label elige nueva fila de cola antes del resultado de Discover y espera
acción Save que esa fila no ofrece. Snapshot muestra Remove from queue y ausencia
Save. Corrección preparada únicamente en cloneAuto: acotar helpermenu a
[data-testid=android-catalog-search]. No cambiar root congelado ni afirmar fix
validado aún. Integrar y ejecutar Catalog2 dirigido al terminar principal.

CloneAuto compile initial Kotlin + androidTest pasa con1worker/Xmx512m,
/tmp/soundsible-auto-compile.log. No ejecuta suites ni ocupa AVD. Cambios después:
childCount total para subscriptions (no tamaño de primera página), integridad
copias sólo enworker, metadata Android Auto+automotive_app_desc media según
https://developer.android.com/training/cars/media/auto. CarLibraryTest extendido
conofflineprep/API503; nueva compile /tmp/soundsible-auto-counts-compile.log
exec pendiente. Native runtimeAuto no probado; no pasar sources al root aún.

Auto clone: providers/cache añadidos allí, NOroot. ProgramCarArtwork +
CarArtworkProvider noexportado/read grants URIopaca, registro400/cache32 imágenes
hasta2MiB, BitmapLoader privado existente, invalidación cuenta/close. Browse/getItem
decoran playableIDs sinengineURL; CarLibraryTest lee imagen roja sintética/cache
503 y rechazaURIvieja. /tmp/soundsible-auto-art-compile.log compile Kotlin+test pasa.
Último fixLRU evitaevictionasyncURIreusada no recompiled aún. RuntimeAuto espera
suite principal (40/144 con2Catalogfallos, al escribir). SLICE_4A enclone guarda
contrato/límites; no afirmarcarpermissionhost externo desdeharnesssameUID.

## Traspaso archivado el 2026-10-06 (hasta S2av)

Sustituido por el HANDOFF conciso. Contenido íntegro anterior:

# Traspaso del port Android

### Decisiones vigentes

- Rama principal `feat/android-port-foundation`; todos los cambios van por PR.
- Completar teléfono, DJ, Live y Android Auto antes de alpha. Development no es release.
- Validar, commit y push; al cerrar paridad, **PR abierta con checks pasando para
  revisión manual**. **No merge, automerge ni release** antes de revisión/merge del usuario.
- Offline B: copias explícitas de música adquirida, «Disponible sin conexión» en
  menús de tres puntos. No adquisición implícita, preparación en shells o autoevicción.
- UI Solid compartida con adaptadores nativos. iOS es Swift independiente;
  no describirla como port Solid sincronizado. Mantener avisos PAL no verificado.
- No hay teléfono físico del usuario. AVD/PCM/CI no prueban escucha, Bluetooth
  o coche real; aceptación física completa para beta según RELEASE_GATES.
- Seguir trabajando después de cada slice. No delegar sin autorización. No final
  por completar un commit. Suites pesadas seriales; dirigidos durante correcciones.

### Estado y evidencia actuales

Principal: `feat/android-port-foundation`. Paridad completa y PR final todavía pendientes;
consultar git/origin para el HEAD actual.
Ver [PORT_PLAN](PORT_PLAN.md), [RELEASE_GATES](RELEASE_GATES.md) y las evidencias;
[historial](HANDOFF_HISTORY.md) conserva diagnósticos y snapshots anteriores.

- Teléfono: biblioteca/colecciones/bookmarks, NORMAL, podcasts, Radio/Autoplay,
  adquisición/review/importación, metadata/letras, Cuenta/Apariencia/Feedback/
  Learning/Subsonic y offline tienen verticales validados. Menús de canción
  compartidos en ruta/cola; sources y placement DJ desde menús están validados.
- S2ah compartir: native chooser, cápsula pública común o texto local/podcast.
  Share2 + LibraryActions2 + DjContext2,6/0 HTTP/TLS sobre23c5c416 dirty;
  normal APK/test APK/JVM54/lint sin CA. Intent interceptado: no entrega al receptor.
- S2ai recepción: intents VIEW/SEND frío/caliente, antes del login, Play explícito,
  tokens latest-wins y recreate sin replay. Incoming2 + Share2,4/0 HTTP/TLS,
  29.504s sobre9450752c dirty. Fix real: BridgeActivity redespacha intent inicial;
  SharePlugin descarta únicamente el despacho inicial de instancia restaurada.
- S2ai offline: Incoming2/0 HTTP/TLS,19.214s sobref0e02058 dirty; normal APK/test
  APK/JVM54/lint. Copias nuevas conservan youtube_id validado; con APIs503 el
  enlace resuelve copia local. Copias viejas sin identidad requieren prepararse
  de nuevo para matching. Última UI completa204/1595 + TS pasa.
- DJ S3b: Core real, dos decoders estéreo48k/un AudioTrack, técnicas/FX,
  planner/refiner/reparación/placement, source removal, ownership de bridges,
  playback/pausa/background/focus/MediaController y recuperación PCM/red validados
  por bloques. Sources/owned blocks18/0 HTTP/TLS + normal APK/test/JVM54/lint.
  Blocks usa ownership controlado con decoders reales; no todas las combinaciones
  de audio generan bridges en Core. Ver evidence/s3b.json para alcance exacto.
- Ambos inputs PCM:2/0 HTTP/TLS,46.949s sobre450b207d dirty. Ninguna retirada
  sin contraparte sana; al volver outgoing, PCM no silencioso, epoch/reloj retenidos.
  No prueba fallo permanente de ambos streams de red.
- Cola larga servicio/controller:2/0 HTTP/TLS,23.115s sobre6bd23fc4 dirty.
  Core DJ real + append1000; MediaController seek996/6000ms, recorte a4 retiene
  KEY/token/posición/pausa, append a5 y resume PCM. No soak de1000 canciones naturales.
- Última principal verde130/0 sobre d7e95c44 limpio es anterior a los cambios
  anteriores. Restart prepare1/offline1 y normal APK/test/JVM52/lint pasan allí.
- Browser4 último verde anterior a S3: Chromium278/66 skips, WebKit269/75 skips.
  Repetir todos los perfiles antes de PR; nunca sustituir por tests dirigidos.
- Live y firma permanente/update público siguen pendientes. Invitaciones,
  multidispositivo, settings restantes y puente público/App Links siguen pendientes.

### Último bloque integrado y siguiente trabajo

S5a Auto: código trasladado de `/tmp/soundsible-auto-next` sin cambios tras validar.
**12/0 HTTP/TLS,94.079s,runner exit0** en `/tmp/soundsible-auto-search-connection-native.log`.
CarLibrary2 + CarLegacy2 + CatalogSearch2 + TransportReset2 + Connection4.
APK/test APK/JVM54/lint pasan sin CA temporal. Core car/playback11/0.
Ver [S5a](SLICE_5A.md) y [evidence/s5a.json](evidence/s5a.json).

Incluye árbol autenticado, selección canónica, Radio/podcasts, búsqueda sobre
biblioteca adquirida/playFromSearch, copias offline con503 y carátulas otorgadas
por URI opaca.401 limpia copias/programa/grants. SameUID moderno/clásico no prueba
host Google Auto, clasificación trusted externa ni grants a otro UID.

Regresión principal sobredcdd6a3b:144/2,1984.904s,exit1; fallos sólo CatalogSearch
por selector global que abría fila de cola. Normal/restart omitidos por runner.
Corrección c1b8c6b4 confirmada en bloque conjunto; conservar registro fallido en
s3b.json. Principal verde130/0 anterior no equivale a regresión actual verde.

Siguiente S5b: actualización de suscripciones/árbol en background, reconexión y
controles/metadata durante DJ; revisar offline cuando la cookie expira sin401
observado. Corregir guard de root/children frente a generation que cambie entre
capturar epoch y leer identidad (devolver error tipado, nunca excepción del callback).
S5c permite root/copias/search locales con perfil verificado tras expirar cookie;
carpetas Core denegadas y artwork placeholder.8/0 HTTP/TLS,60.403s + normal
APK/test/JVM54/lint sin CA. Ver SLICE_5C y evidence/s5c.json. Carátulas son
cache nativa de proceso; no afirmar covers offline tras muerte de proceso.
Host/DHU y permisos externos siguen pendientes; aceptación física para beta.

S5b validado:8/0 HTTP/TLS,50.108s,exit0 + normal APK/test/JVM54/lint sin CA.
Ver SLICE_5B y evidence/s5b.json. Native socket lazy del car actualiza labels y
playlist counts tras cerrar Activity, conserva KEY/PCM y respeta unsubscribe.
401 concurrente devuelve autenticación expirada a browse pendientes; reset por
desconexión conserva otra razón. Root/children toleran cambio de epoch al leer
identidad. No hay suite activa después de exec21942; AVD5554 sigue disponible.

S5c validado y pushed6c906d2f: cookie expirada sin401 no elimina copias con
backend503; root/search/play locales y logout probados en bloque8/0,60.403s,exit0.
No hay suite activa tras exec24330.

S5d validado: observer de copias locales, bloque8/0 HTTP/TLS101.090s y
completado en background2/0,38.286s; ambos normal APK/test/JVM54/lint sin CA.
Ver SLICE_5D/evidence/s5d.json. No hay suite activa tras exec53504.

S5e validado: CarDjTest2/0 HTTP/TLS + normal APK/test/JVM54/lint sin CA;
ver SLICE_5E/evidence/s5e.json. Browsers moderno/clásico conservan programa DJ
al browse/pausa/seek/resume y reflejan canción dominante. Sin suite activa tras49040.

S5f validado: CarEventsTest2/0 HTTP/TLS + normal APK/test/JVM54/lint sin CA.
Transport close + handshake503 observado, reconexión recupera etiqueta perdida
con Activity cerrada y conserva NORMAL KEY/PCM. Producción sin cambios; fixture
acelera heartbeat sólo en test. Ver SLICE_5F/evidence/s5f.json. Sin suite activa tras6518.

S5g validado: externo sin trust rechazado y listener autorizado browse/read PNG
por URI opaca, write denegado. CarExternal2 + Legacy2 + Library2,6/0 HTTP/TLS
+ normal APK/test/JVM54/lint; ver SLICE_5G/evidence/s5g.json. Fix producción:
fallback a confianza del sistema API28+ sólo con paquete/UID verificado.
Sin suite activa tras95429.

S5h validado: CarExternal2/0 HTTP/TLS + normal APK/test/JVM54/lint sin CA.
Externo playFromMediaId observa ID canónico/playing y PCM; URI reabre antes de
logout y se deniega después. Ver SLICE_5H/evidence/s5h.json. Sin suite activa tras75392.

Prioridad corregida por coste/tiempo del usuario: detener ampliaciones granulares
Auto por ahora y completar Live, el hueco funcional mayor. Luego cerrar pendientes
teléfono/DJ/Auto, firma y regresión final/browser4. Host Google Auto no ejecutado.

S4a validado: LiveInputTest3/0,12.817s (NORMAL Core HTTP/TLS + PCM sintético),
runner exit0 y normal APK/test/JVM54/lint sin CA. WebRTC/Opus real entre peers,
mono16k→stereo48k, mute local conserva emisión, pause=ceros y resume recupera PCM.
Sin AudioRecord ni permiso de micrófono; entrada nativa post-DSP/pre-volumen.
Ver SLICE_4A/evidence/s4a.json. Dependency SHA fijo, recorder Java JNI reemplazado,
resto SDK/binarios intactos y licencias en assets; Python2/0, normal recheck notices.
Siguiente: WHIP/WHEP con relay aislado, luego sala/chat/background/UI. No Live
completo ni paridad. Sin suite activa tras63622/74578. No copiar clone Auto viejo sobre root; fuente vigente es root. Actualizar árbol no prueba labels
actualizadas del programa activo. Luego UID externo, negativos DJ, Live/teléfono/
firma y regresión final/browser4. Clone /tmp/soundsible-auto-next ya se trasladó;
no copiarlo sobre root actual. No aplicar stash/clone viejo. No merge/automerge/release.

### Comandos y reglas operativas

- JDK21: /home/arsu/.cache/soundsible/android-toolchain/jdk/jdk-21.0.12.1+1;
  SDK: /home/arsu/.cache/soundsible/android-toolchain/sdk. Exportar JAVA_HOME,
  ANDROID_HOME y sus bin en PATH **para prepare e integration**.
- `.venv/bin/python scripts/android.py prepare`; integración con android.py
  integration. Dirigidos mediante ORG_GRADLE_PROJECT_android.testInstrumentationRunnerArguments.class.
  Gradle sólo :app:*; jamás npm run build en ui_web. UI: npm test + tsc.
- No usar motor/cuentas reales. Fixtures5097/5098/5099; no loguear secretos.
- Antes de PR: suites completas browser4, fetch y ancestry origin/main actual,
  exactly one impact label. Cada implementación validada termina commit/push.
- Clone viejo /tmp/soundsible-android-next tiene sharing ya integrado y network
  viejo en stash; no aplicar ni copiar sobre principal actualizado.
- Investigación Live anterior no implementada: JavaADM AudioRecord no es entrada
  PCM externa; SamplesReadyCallback no inyecta programa. Validar entrada post-DSP/
  pre-volumen sin micrófono y recepción independiente antes de claim de emisión.

S4b relay nativo validado: Core HTTP/TLS crea sesión firmada en Community real;
WHIP HTTPS autenticado → MediaMTX fijado por digest → WHEP HTTPS → PCM nativo.
Mute local, pausa/silencio, resume, Activity cerrada y segundo publisher rechazado
sin perder tap.2/0,runner exit0 + normal APK/test APK/JVM54/lint sin CA.
Ver SLICE_4B/evidence/s4b.json. El runner inicia relay desechable automáticamente
en principal o filtro LiveRelayTest. Siguiente prioridad: socket/lease y metadata
de host desde servicio, adaptador UI y escucha MediaSession. No paridad todavía.

S4c host propiedad de PlaybackService: sesión firmada, WHIP + socket Community,
metadata/heartbeat sin Activity, título y chat; secretos sólo en servicio.
Host2 + Relay2 + Input3,7/0,42.984s,runner exit0 y normal APK/test APK/JVM54/lint
sin CA. Fin explícito borra sala conservando KEY/playback local. Ver SLICE_4C y
evidence/s4c.json. Siguiente: escucha nativa MediaSession y controles UI; después
DJ/metadata/artwork y recovery. No suite activa tras exec30219. AVD5554 sigue.

S4d escucha NativeLivePlayer en MediaSession: Listener2 + Host2 + Relay2 + Input3,
9/0,54.967s,runner exit0 + normal APK/test APK/JVM54/lint sin CA.
PCM independiente vía relay, pausa/volumen/Activity cerrada/stop-prepare/vuelta
a NORMAL; Live recibido no se recaptura para emisión. Fix real: comandos de
selección de música al salir de Live. Ver SLICE_4D/evidence/s4d.json.
Siguiente: controles UI + guest socket/metadata/artwork, después DJ/recovery.
No suite activa tras exec11498. AVD5554 sigue. PR sólo abierta/revisión manual.

S4e UI/guest nativo: directorio por NativeLiveDirectory (WebView bloquea JSON
remoto), host y guest controles/chat reales desde Solid→Capacitor→servicio.
Guest recibe programa/metadata MediaSession/chat/presencia/fin desde socket nativo.
Estado JS sin tokens. Escucha oculta cola/letras/DJ/autoplay como acciones de canción.
Combinado11/0,71.289s antes del probe401; intento final11/2 sólo por marcador
fixture omitido en ambos probesUI (otros9 pasan). Corregido test; UI2/0,20.704s,
runner exit0 + normal APK/test APK/JVM54/lint.205/1599 y TypeScript pasan.
UI prueba emisión/título/chat/fin y directorio/escucha PCM/pausa/volumen/chat/salida,
además401 real→login/biblioteca/panel retirados. Ver SLICE_4E/evidence/s4e.json.
Siguiente Live: DJ/transition metadata + artwork públicos; recovery de media/red/
lease y handshake/reset/proceso. No suite activa tras exec29062. AVD5554 sigue.

S4f validado: Host4/Listener2,6/0,76.723s,runner exit0 + normal APK/test APK/JVM54/lint
sin CA. DJ real al relay con dos pistas/ganancias/progreso de mezcla, NORMAL
publica carátula privada y guest recibe thumbnail público en MediaSession.
Cliente HTTPS separado sin cookies Core, origen/sala/bytes/dimensiones acotados.
Fix cierre TLS sólo en worker; seed DJ determinista desde current. Ver SLICE_4F
y evidence/s4f.json. Log /tmp/soundsible-live-s4f-corrected-native.log. No suite
activa tras58980. AVD5554 sigue. Siguiente: recovery media/red/lease y handshake/
reset/proceso; después regresión conjunta Live. No paridad, merge ni release.

S4g validado: Live combinado14/0,148.745s, runner exit0 + normal APK/test APK/
JVM56/lint sin CA temporal. Host4/Listener2/UI2/Relay2/Input3/Handshake1: cortar
publisher real conserva sala y recupera PCM; cortar listener real conserva pausa,
volumen e identidad. OPTIONS TLS lento10s se cancela desde main en menos3s.
LivePeer.cancel + DELETE2s + Location/media; retries1/2/4s deadline30s; watchdog
lease10s implementado pero agotamiento/lease aún sin aceptación dirigida.
Ver SLICE_4G/evidence/s4g.json, log /tmp/soundsible-live-recovery-native.log.
No suite activa tras13061. AVD5554 sigue. Siguiente: autorización guest antes de
WHEP (hoy Socket y media arrancan en paralelo), lease/polling y process death/
resume409; reset de servicio durante handshake. Luego negativos DJ, teléfono/
Auto/firma y regresión final. No paridad, merge, automerge ni release.

S4h validado: Host4/Listener2 pasan en combinado9/2; TLSUI chat se enviaba
antes de terminar title, y una sala sin limpiar contaminó Polling. Sólo tests
corregidos: UI2/Polling1,3/0, runner exit0 + normal APK/test APK/JVM56/lint.
Producto idéntico entre runs. Ver SLICE_4H/evidence/s4h.json, logs
/tmp/soundsible-live-leases-native.log y /tmp/soundsible-live-leases-ui-fixed-native.log.
Host/guest esperan autorización Socket antes de WHIP/WHEP; rechazo sala con
WHEP real no produce PCM. Lease perdida en background retira Live tras10s,
conservando local; polling-only35s sobre ping20s estable. No suite activa tras
31747. AVD5554 sigue. Siguiente: proceso/resume409 y agotamiento/reset. El
publisher muerto puede seguir ocupando MediaMTX aunque Core rote tokens;
continuidad debe retirar sólo la resource del owner firmado y probarse en relay
real, no basta POST resume. Sources vigentes root. PR no creada aún (ghprview
verificado). No final de checkpoint, no merge/automerge/release.

S4i validado: resume firmado retira publisher real antes de rotar credenciales,
conserva sala/programa y protege DELETE tardío con if_host_token. Native crea o
reanuda409 y continúa seq. Core19/0; LiveResume HTTP/TLS2/0,16.256s;
LiveRestart prepare1/0,5.935s + force-stop + resume1/0,5.277s: PID distinto,
cookie cifrada conservada, misma sala, seq creciente y PCM WHEP independiente.
Ambos runners exit0 + APK/test APK/JVM56/lint normales sin CA temporal.
Logs /tmp/soundsible-live-resume-fixed-native.log y
/tmp/soundsible-live-process-restart-native.log. Ver SLICE_4I/evidence/s4i.json.
No regresión principal/browser completa en este bloque. AVD5554 sigue, ninguna
suite activa. Siguiente: agotamiento/reset/foco Live, después restantes teléfono/
DJ/Auto/firma y regresión final. PR abierta para review manual cuando paridad;
no merge, automerge ni release. Ping Community20s/timeout25s corregido en docs.

S4j aceptación dirigida4/0,56.701s: listener rechazos reales de autorización relay,
cuatro intentos exactos, agotamiento estable, recuperación manual/volumen, foco
transitorio por AudioManager y noisy por UID sistema. Reset de cuenta durante
OPTIONS TLS lento retira receptor <3s; no reintenta en8s ni acepta prepare viejo.
Runner53807 exit0 + APK/test APK/JVM56/lint normales sin CA temporal. Log
/tmp/soundsible-live-recovery-final.log. Ver SLICE_4J. Siguiente: publisher
agotamiento/reset dirigido, presentación/share Live y pendientes de matriz.

S4k validado: publisher HTTP/TLS2/0,85.109s, runner21182 exit0 + APK/test APK/
JVM56/lint normales. Activity cerrada: tres retries reales rechazados, Live
retirado estable conservando música/KEY, Go live recupera misma sala. Segundo
corte + reset cancela retries sin publisher y sin nuevas autorizaciones en5s.
Log /tmp/soundsible-live-publisher-exhaustion.log, SLICE_4K/evidence/s4k.json.
Ninguna suite activa; AVD5554 sigue. Siguiente: presentación del programa y
compartir Live; luego restantes matriz y regresión final. No merge ni release.

S4l validado: programa primary/secondary/artista/thumbnail/mezcla/pausa y share
público común web→chooser nativo. UI206/1602 + TypeScript pasan. Inicial4/1:
HTTPUI/Share2 pasan; TLSUI pulsó Pause deshabilitado durante cambio volumen.
Test espera controles disponibles; slider deshabilitado durante busy. FinalUI2/0,
24.451s, runner36960 exit0 + APK/test APK/JVM56/lint normales sin CA temporal.
Imagen real WebView, chooser interceptado y rechazo query extra/duplicada/fragment.
SLICE_4L/evidence/s4l.json, /tmp/soundsible-live-presentation-fixed-native.log.
Ninguna suite activa, AVD5554 sigue. Siguiente: invites/admin/multidispositivo
según inventario real, negativos DJ/Auto y distribución; principal/browser4 final
aún pendientes. PR abierta review manual, no merge/automerge/release.

S2aj validado: invite pegado explícitamente en conexión, preview/accept nativo,
contraseña confirmada, bind perfil/cookie y biblioteca aislada sin reload.
Native2/0 HTTP/TLS,17.238s, runner28188 exit0 + APK/test APK/JVM56/lint normales.
Inicial2/2 por helper test que esperaba startup sin configurar aunque Core seguía
configurado; corregido inicio fresh/waitlibrary en recreate. WholeUI208/1606
antes de copy hint y guard de mensaje preview pendiente; dirigido final5/0 y
TypeScript pasan. SLICE_2AJ/evidence/s2aj.json, log
/tmp/soundsible-invite-corrected-native.log. Ninguna suite activa, AVD5554 sigue.
Siguiente: admin y controles/handoff entre dispositivos, negativos DJ/Auto,
distribución y regresión final. No OS invite intent probado aún. PR manual;
no merge/automerge/release. Sources vigentes root.

S2ak validado: Settings Personas sólo admin reutiliza panel web con account/current
y guards tras diálogos/respuestas/copiar; cleanup invalida. WholeUI209/1610 +
TypeScript pasan; UsersTest HTTP/TLS2/0,25.67s, runner53270 exit0 + APK/test APK/
JVM56/lint normales. Admin crea cuenta/invite y desactiva confirmado Core; miembro
sin menú ni acceso /api/users403. SLICE_2AK/evidence/s2ak.json, log
/tmp/soundsible-people-native.log. Ninguna suite activa, AVD5554 sigue. Siguiente
multidispositivo: dueño/socket en PlaybackService con playback_register, eventos
playback_*_requested y estado/handoff Core; no activar audio/store web.
ProgramCarSubscriptions sólo al suscribir Auto, no dueño remoto general. Faltan
negativos DJ/Auto, firma/distribución y principal/browser4 final. PR manual.

S2al accepted: NativeDeviceSession owns authenticated Core registration/control
with Activity closed. NORMAL bounded state and real incoming handoff preserve
queue/index/position/shuffle/repeat; remote resume preserves occurrence identities.
Two Core bugs fixed: socket registration binds its account rather than default;
remote pause retains track/position/session, avoiding immediate-play404.
Core14/0; DeviceSession HTTP/TLS2/0,15.639s; integration exit0 and normal APK/test
APK/JVM56/lint without fixture CA. Log /tmp/soundsible-device-session-final-native.log.
See SLICE_2AL and evidence/s2al.json. No UI change in this slice.
Next device-list UI/outgoing handoff, DJ/Radio workspace and pending catalog
restoration; then remaining pairing/public links, DJ/Auto negatives, distribution
and final principal/browser4. Do not claim full multidispositivo parity yet.
Never merge/automerge/release; final PR stays open for manual review.

S2am accepted: Settings Devices reads native service identity, lists account-scoped
Core devices and sends controls through authenticated native HTTP. UI210/1613+TS;
DevicesUi + DeviceSession4/0 HTTP/TLS,31.097s, runner exit0 + normal APK/test
APK/JVM56/lint. Core15/0; /api/devices now exposes socket_active from active_sid
for shared web/native UI. Earlier UI test failure was API contract mismatch,
not registration overwriting SID; latter was an incorrect intermediate diagnosis.
See SLICE_2AM/evidence/s2am.json. Next outgoing handoff must publish exact fresh
native state then call Core handoff with same-account/generation checks. Full DJ/
Radio/pending catalog restore, public invite intents/pairing, negative coverage,
distribution and final full suites remain. Continue; PR manual, no release/merge.

S2an accepted: Settings transfer delegates to native actor, verifies same-account
online peer, publishes fresh bounded NORMAL queue/position then calls Core handoff.
Queue/preferences/transport/identity changes cancel pre-send, reset cancels future/
request, no optimistic source pause. Real UI to remote Core socket + source pause
HTTP/TLS, combined DevicesUi/DeviceSession4/0,31.965s; normal APK/test/JVM56/lint
and integration exit0. UI210/1614+TS. FR/ZH transfer label added after native runner,
covered by final UI typecheck/tests; no four-language native claim. SLICE_2AN and
evidence/s2an.json. Outgoing DJ disabled until workspace restore complete. Next
DJ/Radio/pending catalog and device reconnect exhaustion; then remaining public
invites/pairing, DJ/Auto negatives, distribution, principal/browser4. Continue.

S2ao accepted: shared auto workspace restored in native dual decoders at index/
position with source trays/direction/profile/heard/avoid/exploration and proposals.
Wire transition fromKey = musical identity, native fromKey = preceding occurrence;
bridge owners remapped; public plan labels preserved. Genuine Core handoff marker
prevents same-queue resume optimization discarding edits from another device.
Native DJ background controls and incoming/outgoing PCM/socket contract, returned
direction edit and malformed-profile refusal pass HTTP/TLS; combined6/0,51.706s;
Core16/0; runner exit0 + normal APK/test/JVM56/lint. SLICE_2AO/evidence/s2ao.json.
NORMAL test seeks shortened for independence from short PCM fixtures; historical
54s/123s evidence unchanged. Next Radio workspace + pending catalog resolution,
device reconnection exhaustion, public invites/pairing, broader negatives,
distribution and final principal/browser4. Do not merge/automerge/publish.

S2ap accepted: Radio seed/profile/intent and generated occurrence ownership survive
incoming/outgoing NORMAL handoff; Stop keeps manual future and current identity.
Autoplay imported markers obey receiver account setting; disabled strips only its
runway. Shared radio fields active/seedId; profile/seed are native extensions,
balanced default for web/common snapshots. Context metadata + identity/loudness
facts retained for imported NORMAL. DeviceRadio+DeviceDj+DeviceSession+DevicesUi
8/0 HTTP/TLS,86.694s; exit0 + normal APK/test/JVM56/lint. See SLICE_2AP/evidence.
Next device reconnect exhaustion and deferred catalog playback/handoff, then
public invites/pairing, broader negatives, distribution and final full suites.
Continue; no PR merge/automerge/publication. Last UI complete210/1614+TS unchanged.

S2aq accepted: exhausted device Socket.IO manager is retired and retried after30s
cooldown with cookie/profile revalidation and stable UUID. Actor reset removes
manager callbacks. Activity-closed real transport503 exhaustion/recovery while
20s PCM repeats, same device registration/publication and restored remote controls
HTTP/TLS2/0; exit0 + normal APK/test/JVM56/lint. SLICE_2AQ/evidence/s2aq.json.
Initial fixture-path test issue corrected with raw test client; no production
path restriction weakened. Next deferred catalogue: retain pending entries and
resolve in native source loader, generation/occurrence guarded, no web audio.
Then public invites/pairing, broader negatives, distribution and final full suites.

### Recuperación del entorno tras reinicio

Workspace vigente: `/mnt/storage/Git-projects-storage/soundsible` en HDD ext4
`/dev/sda1`, montado rw. El 2026-10-06 se verificó escritura/lectura/fsync y fetch
de GitHub; HEAD b119384d ya estaba en remoto. `/home/arsu/soundsible` era un
clone limpio de junio (`new-ui`, HEAD 3e4a961, ancestro del trabajo vigente),
sin commits exclusivos ni archivos no ignorados pendientes. Eliminado a petición
del usuario; `.claude`, `.gstack` y `.env` ignorado se preservaron fuera del repo
en `/mnt/storage/Git-projects-storage/recovered-soundsible-home`. No copiar ese
backup sobre el trabajo vigente ni publicar su contenido. AVD API36 reiniciado.
Los logs `/tmp` anteriores no sobreviven al reinicio; evidence JSON y commits
conservan los resultados históricos, no afirmar que se rerunearon.

S2ar validado: catálogo pendiente en NORMAL y colecciones UI, source loader Core
con Activity cerrada, identidad/contexto conservados, replay sin matcher extra y
reset durante matcher lento sin resurrección. DeviceCatalogSession2 +
CollectionProfile4 + CatalogSearch2 HTTP/TLS8/0,95.019s; runner exit0 y normal
APK/test APK/JVM56/lint. WholeUI210/1616 + TS pasan. Log
`/tmp/soundsible-deferred-native.log`, SLICE_2AR/evidence/s2ar.json.
Siguiente inmediato: matcher404 debe continuar colección; retry temporal acotado,
menús DJ/Radio no deben convertir pendientes en source local. Luego OS invites/
pairing, negativos DJ/Auto, firma/distribución y principal/browser4 final.
PR manual, no merge/automerge/publicación.

S2as validado: matcher404 continúa hacia siguiente canción; dos retries503
recuperan PCM y tres intentos agotan estable; Retry explícito conserva fila y
recupera. HTTP/TLS2/0,51.339s + runner exit0 y normal APK/test APK/JVM56/lint.
WholeUI210/1617+TS; Core fixture1/0. SLICE_2AS/evidence/s2as.json.
Siguiente: guard del menú de ocurrencia pendiente (AndroidStart reconstruye
actualmente fallback sin pendingResolve), e invites VIEW/SEND con acción explícita
sin cambiar cuenta/origen al recibirlos. Luego pairing/negativos/firma/final.

S2at validado (Claude Code toma el relevo de Codex): invite compartido por SEND es
propuesta; sin sesión Conectar, con sesión aviso + «Usar invitación» cierra sesión
explícitamente (Android hace la elección, no copia el descarte web). Menú de
ocurrencia pendiente sólo retira (negativo verificado). Combinado8/0 HTTP/TLS,
66.403s, runner exit0 + APK/test APK/JVM56/lint; UI211/1620+TS. SLICE_2AT/
evidence/s2at.json. Paridad = funciones: si la web usa un apaño por limitación
del navegador, Android lo hace de la mejor manera nativa. Siguiente: puente
público/App Links (VIEW https), negativos DJ/Auto, firma/distribución y
regresión final principal/browser4. PR manual, no merge/automerge/publicación.

S2au validado: Settings nativo con Biblioteca, Descargas (admin), Comunidad,
Acerca de y Dispositivos (nombre por instalación + emparejados). Vistas extraídas
de SettingsSections y compartidas con la web. Nombre por defecto del sistema y
re-registro inmediato. Bloque22/0 HTTP/TLS,280.499s + normal; UI213/1631+TS.
SLICE_2AU/evidence/s2au.json. Siguiente: inventario de
paridad restante (biblioteca/búsqueda/cola/podcasts), negativos DJ/Auto, firma y
regresión final principal/browser4. PR manual, no merge/automerge/publicación.

S2av validado: el usuario decidió que el QR de emparejamiento inicie una sesión
completa de la cuenta que lo muestra (no token restringido como iOS). Core claim
`credential: session` sólo con hoja abierta, vinculada y revocable; Android escanea
con CameraX+ZXing (sin GMS) o código escrito; QR usa la dirección visible/servidor
conectado. Bloque20/0 HTTP/TLS,235.817s + normal JVM59/lint; Core78; UI215/1637.
SLICE_2AV/evidence/s2av.json. Siguiente: inventario de paridad restante
(biblioteca/búsqueda/cola/podcasts), negativos DJ/Auto, firma y regresión final
principal/browser4. PR manual, no merge/automerge/publicación.

