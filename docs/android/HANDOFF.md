# Traspaso del port Android

## Decisiones vigentes

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

## Estado y evidencia actuales

Principal/remote **5290684b** (código Native preparado en dcdd6a3b). Paridad completa y PR final todavía pendientes.
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

## Trabajo activo: comprobar antes de editar

Regresión principal sobredcdd6a3b: **144 tests,2 fallos,1984.904s,exit1**. Tracked limpio al
prepare; incluye draft ProgramCarLibrary no conectado/no committed. Log
`/tmp/soundsible-android-dcdd-regression-native.log`, exec62863.
Terminada; el runner omitió restart/build normal tras los fallos. Registro en
`evidence/s3b.json`; no sustituirlo por confirmación dirigida. AVD headless exec76258, emulator-5554.

Dos fallos encontrados: CatalogSearchTest HTTP/TLS. Selector global por aria-label
abre nueva fila de cola antes del resultado Discover; espera Save que esa fila
no ofrece. Corrección preparada en clone, acota helper a android-catalog-search.
Integrar sólo después de terminar la principal y ejecutar Catalog2 dirigido.
No reemplazar el registro de principal fallida por el dirigido.

Checkout independiente **/tmp/soundsible-auto-next**, rama
`feat/android-auto-continuation`, base dcdd6a3b. No worktree compartido. Allí:

- ProgramCarLibrary integrado con PlaybackService browse/getItem/subscription y
  selección de IDs publicados. Metadata/URI del caller no crean fuentes.
  Controllers externos trusted, sin append arbitrario ni comando privado de cola.
- Copias completas del perfil en árbol offline; fallback root503 sólo con copias.
  Hash/integridad en worker, fuera del looper del reproductor. Futures terminan
  al reset/close; cache y páginas acotadas.401/403 diferenciados.
- Manifest descriptor Android Auto media, sin Android Automotive OS/templates.
- ProgramCarArtwork/CarArtworkProvider: provider no exportado, grants read de
  URI opaca al browser; loader privado, registro400/cache32 thumbnails hasta2MiB,
  revocación/limpieza al cambiar cuenta. Fix LRU de eviction async y aislamiento por identidad compilan;
  runtime pendiente. No prometer revocar bytes/descriptores que el cliente ya recibió.
- CarLibraryTest HTTP/TLS preparado: MediaBrowser real, root/children/subscribe,
  música PCM, ID de otra cuenta desconocido, URI/título falsificado ignorado,
  offline503 y carátulas/cache/rechazo tras logout. **Runtime no probado todavía.**
- Compile Kotlin+androidTest1worker/Xmx512m pasa en auto-compile.log,
  auto-counts-compile.log y auto-art-compile.log. Logs bajo /tmp/soundsible-*.
- Ejecutar Native Auto después de principal; preparar assets del clone y
  ejecutar CarLibraryTest + CarLegacyTest + CatalogSearchTest (6 casos HTTP/TLS). No copiar draft root viejo sobre clone nuevo.
- SLICE_5A en clone tiene contrato/fuentes. Radio/podcasts y revocación401 compilan
  con pruebas preparadas; runtime, cambios proactivos de árbol/background,
  permisos a host externo y host/DHU pendientes.
  MediaBrowser sameUID no equivale a Android Auto validado.

Después: registrar principal/fallos, integrar Catalog fix, validar Auto, negativos
Core DJ pendientes y regresión final actual; continuar Live/teléfono/firma.
Nunca habilitar merge/automerge ni publicación como consecuencia de tests verdes.

## Comandos y reglas operativas

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

Actualización clone Auto (S5a, S4 corresponde a Live): CarLegacyTest y extensión
CarLibraryTest con acquired podcast seek/resume120s, Radio+refill, covers/cache y
revocación401 compilan; /tmp/soundsible-auto-auth-compile.log. Radio Core filtra
podcasts antes de límite200; Core tests9/0 en /tmp/soundsible-auto-core-tests.log.
Artwork tiene loader propio y limpia por identidad de sesión, además de generation.
Runtime pendiente. Compilar no cierra Auto ni prueba permisos de host externo.

Auto/Catalog dirigido en curso: exec4752, /tmp/soundsible-auto-catalog-native.log,
6 casos HTTP/TLS. Assets preparados tras fix de límite offline1000. Congelar
clone Native/UI/fixtures hasta exit y build normal. Root libre; no copiar fuentes
al clone ni sobrescribir su preparación.
