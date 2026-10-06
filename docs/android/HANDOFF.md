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
Siguiente DJ: menús de ruta/cola con acciones compartidas y placement fijo,
negativos restantes y límite largo en servicio.
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
