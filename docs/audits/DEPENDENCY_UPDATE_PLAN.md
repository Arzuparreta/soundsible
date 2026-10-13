# Actualización de dependencias en tres bloques

Decisión del mantenedor, 2026-10-11: empezar por seguridad y coherencia,
completar las validaciones y dejar una PR abierta, sin fusionarla.

## Bloque 1 · Valor inmediato

- Corregir los avisos compatibles de Python, npm y Rust, sin migrar herramientas
  ni plataformas. Elevar también los mínimos de seguridad para instalaciones
  nuevas y regenerar el lock Docker con Python 3.13, conservando el resto.
- Alinear yt-dlp del sidecar con el motor; el empaquetado lo instalaba después
  de los requisitos generales y podía retroceder a una versión anterior.
- Corregir y diagnosticar el fallo Android de `main` señalado por el mantenedor.
- Validar antes de abrir la PR; esperar todos los checks de su último head.

Cambios de esta entrega:

| Área | Cambio |
| --- | --- |
| Python | cryptography 50.0.2 salvo Mac Intel (48.0.1 a <49 para conservar wheels), Werkzeug 3.1.9, urllib3 2.8.0 y Flask 3.1.3. |
| Comunidad | Flask 3.1.3, Werkzeug 3.1.9 y cryptography 50.0.2; Flask-SocketIO 5.6.1 por compatibilidad con el RequestContext de Flask corregido. |
| Sidecar | yt-dlp 2026.8.19, igual que requirements.txt. |
| npm | Vitest 4.1.11 en los dos clientes; Solid 1.9.17 permite seroval/seroval-plugins 1.6.9. Locks con los patches compatibles de los transitivos afectados y sus dependencias. |
| Rust | rustls 0.23.42 → 0.23.45 y rustls-webpki 0.103.13 → 0.103.15; resto del lock conservado. |

### Avisos que no se resuelven forzando versiones

La revisión detectó que cryptography 49 eliminó los wheels de macOS x86_64.
La instalación nativa documentada no exige Rust/OpenSSL para compilarla:
requirements.txt selecciona >=48.0.1,<49 sólo en Mac Intel, la última línea con
wheels universales, y >=50.0.2 en el resto. No se presenta esa excepción como
libre de avisos: OSV conserva tres problemas distintos (PKCS#7 y dos del
verificador X.509), también publicados como PYSEC. Soundsible usa Fernet,
PBKDF2 y Ed25519; no invoca descifrado PKCS#7 ni el verificador X.509 de
cryptography. La excepción y sus avisos se mantienen visibles; el resto de
plataformas y los contenedores reciben la versión corregida. Véanse el
[changelog](https://cryptography.io/en/50.0.2/changelog/#v49-0-0) y
[los wheels de 48.0.1](https://pypi.org/project/cryptography/48.0.1/#files).

`npm audit` pasa de 13 paquetes afectados a 3 en web y de 4 a 0 en la shell.
En web queda una sola cadena moderada: `@capacitor/cli → xcode → uuid`.
El [aviso UUID](https://github.com/advisories/GHSA-w5hq-g745-h8pq) afecta a
v3/v5/v6 con buffers; `xcode/lib/pbxProject.js` usa `uuid.v4()` sin buffer.
Además, Soundsible usa Capacitor para Android y su iOS es Swift independiente.
Se conserva el aviso documentado: no se fuerza un major de uuid dentro de xcode
ni el downgrade de Capacitor que propone `npm audit fix --force`.

OSV consultó las 656 combinaciones paquete/versión fijadas de Docker, comunidad,
sidecar y Cargo: no quedan avisos Python ni el aviso TLS corregido de rustls.
Queda `glib` 0.18.5 en la cadena GTK de Linux, con
[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html).
`cargo tree --locked --target x86_64-pc-windows-msvc --invert glib` y la misma
consulta para ARM64 no encuentran ese paquete en los instaladores Windows,
los únicos clientes desktop distribuidos. El lock conserva la dependencia de
Linux de Tauri; no se fuerza glib 0.20 dentro de una familia GTK incompatible.

Los otros siete avisos Rust son de mantenimiento: `paste`, `proc-macro-error`
y cinco `unic-*`. Se mantienen visibles para el bloque 2; no se presentan como
siete vulnerabilidades explotables ni como problemas resueltos.

### Fallo Android y diagnóstico

El [run de main](https://github.com/Arzuparreta/soundsible/actions/runs/38135594239)
falló en `LiveListenerTest.httpCoreRelay`, con
«Activity close stopped remote programme». Los otros tres shards y el build
aprobaron. El log muestra el receptor activo hasta el cleanup tras la aserción;
eso no demuestra por sí solo que hubiera audio ni permite culpar al cierre.

La prueba mezclaba recuperación WHEP, estado READY y audio tras cerrar la
Activity. Ahora exige audio decodificado nuevo después de la recuperación,
antes de cerrar, y al menos 50 buffers no silenciosos después del cierre.
Cuenta los buffers en el callback: una lectura de la última RMS cada 50 ms
podía perder buffers que llegaban entre dos polls. El timeout conserva los
20 segundos; no se añaden reintentos. El fallo imprime estado del controlador,
buffers decodificados/audibles, buffers del publicador y última RMS para
distinguir transporte, fuente, audio y lifecycle en una futura regresión.

De los últimos 25 runs Android examinados, 18 aprobaron, 4 fallaron y 3 fueron
cancelados. Los fallos no tienen una causa única: dos fueron el registro de
cookies incompleto del fixture de podcasts (ya corregido en main), otro tuvo
expectativas de menús desactualizadas (ya corregidas en PR #344) y el último
fue Live. No se concluye que todo CI Android sea flaky ni que repetirlo cierre
un fallo: cualquier nueva aserción debe revisarse con sus artefactos.

### Validación

- Python 3.13, instalación del lock con hashes: 1921 pruebas, cobertura 76,54 %;
  Ruff, pip check y sincronización de versión aprobados.
- Excepción Mac Intel: selección de markers en cinco combinaciones de
  plataforma/arquitectura; pip download --only-binary recupera el wheel universal
  de 48.0.1 para CPython 3.13/macOS x86_64. Con 48.0.1, 38 pruebas de backup,
  identidad comunitaria y autenticación Subsonic aprobadas en Linux; no se
  presenta esa comprobación como una ejecución nativa en macOS.
- Servicio comunitario en un entorno separado con sus pins reales: 21 pruebas.
  Flask-SocketIO 5.5.1 falló con Flask actualizado; 5.6.1 corrigió esa combinación.
- Web: 1720 pruebas Vitest y typecheck. Shell: 9 pruebas y 13 casos de navegador.
- Chromium móvil/escritorio: 320 aprobados, 66 skips definidos por los perfiles.
- LiveListener HTTP/TLS: tres ejecuciones de la clase final, 6 casos aprobados,
  más JVM/lint/APK en cada ejecución. Evidencia en docs/android/EVIDENCE.md.
- WebKit móvil/escritorio: 311 aprobados, 75 skips definidos por los perfiles,
  imagen Playwright sobre mount de sólo lectura y un worker, después de Chromium.
- Imagen Docker comunitaria construida; importa las versiones esperadas,
  SQLite responde. Sin relay, /health devuelve 503 con mediamtx=error, como exige
  el contrato; el smoke con relay completo también se comprueba en GitHub CI.
- El cargo test Linux local está limitado por la ausencia de javascriptcoregtk
  4.1. La compilación, empaquetado y smoke de los clientes Windows x64/ARM64 se
  validan mediante Desktop Build en el último head de la PR.

## Bloque 2 · Mantenimiento compatible

Clientes e infraestructura se validaron inicialmente en las PR #347 y #346.
Para reducir CI antes de fusionar, ambos cambios se integran ahora en #347:
un solo head combinado, una revisión independiente y todos sus checks completos.
#346 queda incorporada; no se publica una release desde esta entrega.

1. **Clientes, Python y Node.** Node 24.21.0 LTS como referencia en `.nvmrc`,
   CI y Docker; los manifests admiten también Node 22.22.2+ y 26. Vite 8.3.4,
   Playwright 1.64.0 (imagen CI derivada del lock), Capacitor 8.5.3 coordinado
   y Tauri 2.12.3 con sus plugins/transitivos compatibles. Python: curl-cffi
   0.16.3, Flask-SocketIO 5.7.0, gevent 26.9.0, PyInstaller 6.22.3 y regeneración
   completa del lock Docker con hashes bajo Python 3.13. Se conservan los mínimos
   compatibles de la instalación nativa y la excepción Mac Intel del bloque 1.
2. **Infraestructura.** Actions, MediaMTX, Coturn y FFmpeg, con validación propia;
   evidencia en `docs/audits/DEPENDENCY_INFRASTRUCTURE.md`. No se
   requiere desplegar para revisar estas entregas.

Vite 8.3 exponía un fallo reproducible en el scan de dependencias con
`import.meta.glob` dentro de TSX: después de quitar tipos, intentaba parsear JSX
como JavaScript. Los dos globs de recuperación se extraen a módulos TS sin JSX;
conservan carga diferida y el URL alternativo `?recovery` requerido por WebKit.
El arranque con cache frío ya no falla. Los tests de navegador esperan el estilo
tras el reflow y miden geometría en el mismo frame; la comprobación de reproducción
tras recuperar un módulo encuentra también la mini-player oculta bajo el panel.
El fixture DJ espera que el contenido del panel sea visible antes de responder
por primera vez y mantiene pendiente la respuesta final hasta comprobar la espera; una animación lenta no puede consumir ese estado antes de la aserción.
Con dos CPU y el arranque frío se reprodujo además un fallo real WebKit: la
regla global de movimiento reducido daba una duración no nula a la transición
de visibilidad de cada descendiente. El panel se revelaba capa a capa y sus filas
seguían ocultas bajo carga. La regla ahora desactiva las transiciones; conserva
los eventos de animación y la preferencia del usuario. No se aumenta el timeout
ni se añaden retries ni se reduce la exigencia del audio Android.
En producción, el fixture de avería mantiene el 503 hasta pulsar retry: fallar
sólo el preload dejaba que el import posterior cargase el módulo correctamente.
Las cuatro acciones de una canción encontrada tienen pruebas independientes y
una sesión restaurada y una cola breve; la prueba de favoritos parte de una
canción ya guardada, como exige el producto. La cobertura de colas largas
permanece en sus propios casos.
Un segundo shard señaló como flaky la prueba móvil que acumulaba dos inserciones
y la geometría de movimiento. Cada inserción tiene ahora un caso propio y la
geometría prepara dos peticiones mediante el store real. El fixture móvil sirve
WAV silencioso válido en vez del fallback JSON, evitando fallos de decodificación
que avanzaban el transporte durante los gestos. No se cambian retries ni timeout.

Validación local de clientes/Python:

- Instalación del lock Docker con hashes: 1921 pruebas Python, cobertura 76,54 %;
  Ruff, comprobación de dependencias y sincronización de versión aprobados.
- Entorno comunitario con sus pins reales: 21 pruebas aprobadas.
- Web: typecheck y 1720 pruebas; shell: 9 pruebas y 13 casos de navegador.
- Antes de abrir la PR, Chromium móvil/escritorio: 320 aprobados y 66 skips de los perfiles. Después,
  WebKit móvil/escritorio: 311 aprobados y 75 skips, imagen Playwright de sólo
  lectura y un worker. El caso DJ también pasó seis ejecuciones aisladas
  consecutivas en WebKit. Los fallos se diagnosticaron y corrigieron antes de
  abrir la PR; se exige además todo GitHub CI aprobado en su último head.
  El primer CI falló en el refresco de biblioteca. Su fixture sólo cerraba
  playback y dejaba vivos syncs/timers del cliente anterior.
  Ahora llama a disposeStore completo antes de cambiar el registro de módulos.
  Las pruebas de ownership DJ y tokens podcast esperan el estado observable
  esperado, no un solo turno de temporizador que podía terminar antes del trabajo
  asíncrono en runners cargados; conservan sus aserciones originales.
- Tras los arreglos del CI: recuperación del módulo en producción aprobada en
  los cuatro perfiles y las ocho acciones DJ aprobadas en WebKit móvil/escritorio
  limitado a dos CPU. La repetición completa aprobó 328 casos Chromium (68 skips) y 319 WebKit
  (77 skips), en ese orden y sin retries locales. Se exige además verde en cada
  check del último head remoto antes de dar por completada la entrega.
- Android: StartupTest, PlaybackTest y LiveListenerTest, 5 casos nativos HTTP/TLS
  aprobados en AVD API 36, más JVM/lint/APK de desarrollo con JDK 21 seleccionado
  sólo para esos comandos. La prueba local no incluye OfflineRestartTest;
  los cuatro shards completos y Windows x64/ARM64 se validan en GitHub CI.
- Cargo local sigue limitado por javascriptcoregtk 4.1 ausente; no equivale a
  validar los instaladores Windows. No se cambia el Java ni Node global.

Avisos: `npm audit` mantiene la cadena moderada Capacitor CLI → xcode → uuid
(3 paquetes web, ninguno en shell) con la disposición documentada en bloque 1.
OSV consultó 662 combinaciones fijadas: ningún aviso Python en esos locks; quedan
`glib` 0.18.5, `paste` y `proc-macro-error`. Los cinco `unic-*` abandonados salen
con la familia Tauri nueva. `glib` sigue ausente en ambos targets Windows. `dirs`
6 sigue siendo la dependencia directa; el nuevo `dirs` 7 del lock es un transitivo
Tauri, no una migración del código propio. La excepción Mac Intel conserva sus
avisos y sus límites tal como se explicó en el bloque 1.

## Bloque 3 · Migraciones mayores

Estado comprobado el 2026-10-12: los bloques 1 y 2 están integrados en `main`
(PR #345 y #347). Todos los checks del último head de #347 aprobaron, salvo
el tag de release omitido deliberadamente. #346 quedó incorporada al bloque 2.

Primera entrega del bloque 3: transporte Android y directorios desktop.

- OkHttp 4.12.0 → 5.4.0. Gradle selecciona el artefacto Android y alinea las
  cadenas Media3 y Socket.IO en la misma versión. Conserva minSdk/targetSdk y
  compileSdk 36; no se activa ECH ni se cambia la política de certificados,
  redirecciones o DNS de Soundsible. Las correcciones de HTTP/2, timeouts y
  transporte están descritas en el [changelog oficial](https://raw.githubusercontent.com/square/okhttp/master/CHANGELOG.md).
- Se probó 5.5.0: `:app:checkDebugAarMetadata` la rechaza porque exige
  compileSdk 37. El AAR de 5.4.0 exige 36. El salto a 5.5 queda unido a la
  evaluación de AGP/SDK, sin suprimir ese gate ni elevar SDKs automáticamente.
- dirs 6 → 7 como dependencia directa; la versión 7 ya estaba en el lock por
  Tauri. Sólo cambia la selección de Soundsible en el lock. El cambio incompatible
  afecta a `preference_dir` en Windows; el código propio sólo usa `config_dir`,
  cuyo destino no cambia. Véase el [changelog de dirs](https://docs.rs/crate/dirs/7.0.0).
- Cargo completo local sigue bloqueado por JavaScriptCoreGTK 4.1 ausente.
  El módulo real `state.rs` compila con dirs 7 en un crate temporal y sus cinco
  pruebas existentes aprueban. Esto no sustituye el empaquetado Windows de CI.

Validación local: 64 pruebas JVM, lint y APK aprobados; StartupTest,
PlaybackTest y LiveListenerTest en AVD API 36, cinco casos aprobados por
HTTP/TLS sin skips. Inicializador AndroidX de OkHttp presente en el manifest
combinado. Evidencia y limitaciones en `docs/android/EVIDENCE.md`.
El primer CI detectó `StackOverflowError` en los shards 0 y 3: cuando se
retira un executor propio, OkHttp 5 puede llamar a `onFailure` en el mismo stack
de `enqueue`. Engine.IO intenta cerrar polling desde ese callback y reentra
antes de marcar el transporte como cerrado. `SocketIoCallFactory` encola los
fallos en EventThread en todos los transportes Socket.IO; conserva cancelación,
clonación y callbacks de respuesta. No se retrasa ni se elimina el shutdown del
executor. La prueba JVM usa handshake y el executor real detenido: reproduce
el desbordamiento sin el adaptador y aprueba con él. Once casos nativos de
marcadores, recuperación Live, polling y reset HTTP/TLS aprueban; suite JVM:
65 pruebas. Logs en `/tmp/soundsible-socketio-integration.log` y
`/tmp/soundsible-socketio-baseline.xml`.

El gate remoto exige los cuatro shards Android y los dos instaladores Windows
en el último head de la PR. No se publica ni se fusiona automáticamente.

Pendientes tras esta entrega; evaluar beneficio, compatibilidad y coste:

- Python 3.15; Debian Trixie se aborda en la entrega descrita abajo.
- Vitest 5: entrega descrita abajo.
- AGP 9 + Gradle 9 + Kotlin integrado: entrega descrita abajo.
- OkHttp 5.5 junto con compileSdk 37: entrega descrita abajo.

No se elevan automáticamente los mínimos Android/iOS. Cada migración requiere
su validación funcional y de empaquetado; estar en latest no es un gate de
compatibilidad. AltStore PAL continúa sin verificar. No se publica una release
ni se modifica la versión de Soundsible en estos bloques.

### Vitest 5 · 2026-10-12

#349 se fusionó en `main` después de 26 checks aprobados, cuatro skips de
workflow y revisión Codex del head `49d6013d` sin hallazgos ni comentarios inline.

Web y shell pasan de Vitest 4.1.11 a 5.0.4 con sus locks. Los mínimos existentes
Node/Vite satisfacen los requisitos nuevos. Se acepta `clearMocks: true` por
defecto: ninguna prueba requiere historial compartido entre casos. No se añaden
flags de compatibilidad ni se modifican aserciones, configuración o código de
producto. Sólo se actualiza Vitest y sus transitivos asociados. Referencia:
[guía oficial de migración](https://vitest.dev/guide/migration/).

Validación local: typecheck y 1.720 tests web; nueve tests shell; suite completa
Chromium móvil/escritorio, 328 aprobados y 68 skips; después WebKit móvil/escritorio,
319 aprobados y 77 skips, un worker y mount de sólo lectura, sin retries.
Logs `/tmp/soundsible-vitest5-{ui,shell,chromium,webkit}.log`. No se ejecuta
`npm run build` local. npm audit conserva los tres paquetes de la cadena moderada
Capacitor CLI/xcode/uuid en web y ninguno en shell. Los checks remotos del último head son obligatorios antes del merge. La
revisión remota es opcional; puede sustituirse por un subagente agnóstico del
harness o omitirse según el cambio. La cuota de otra cuenta no bloquea el trabajo.

### Debian Trixie · 2026-10-12

#350 (Vitest 5) se fusionó tras checks completos aprobados y revisión Codex
sin hallazgos del head `d05f92a2`. El primer smoke Windows x64 llegó a motor
saludable y segunda apertura, pero falló en restaurar desde tray, con un error
COM de foco. Una repetición del mismo job/commit en un runner nuevo aprobó la
aserción intacta. Windows ARM64 y los cuatro shards Android aprobaron.

Los stages Node 24/Python 3.13 del motor pasan de Bookworm a Trixie. La imagen
comunitaria y su stub CI declaran Trixie explícitamente en lugar de `slim`
flotante. Python, lock con hashes, usuario/UID, volúmenes y puertos conservan sus
contratos; no se elevan mínimos de instalación nativa ni runtimes desktop.

Python 3.15 estable se publicó, pero la comprobación directa de Docker Hub
rechazó `python:3.15-slim-trixie` con `no such manifest`. El catálogo local de
uv sólo ofreció 3.15.0b1 y rechazó 3.15.0; esa beta se eliminó sin usarse en
validación. No se cambia producción a una prerelease ni se construye un runtime
alternativo por defecto. Reabrir Python 3.15 cuando exista la imagen estable y
validar entonces lock, C extensions, gevent/curl-cffi y empaquetado separado.

Validación local: ambas imágenes construidas; motor Debian 13/Python 3.13,
FFmpeg 7.1.5 de Debian y `pip check` aprobados. Diez pruebas de runtime FFmpeg y
sonoridad contra el binario real, diez pruebas comunitarias con sus pins reales
(y herramientas de test aisladas), aprobadas. Motor saludable y HTML/JS
compilados servidos por la imagen; Community health 200 con SQLite y stub
MediaMTX en red aislada. Logs `/tmp/soundsible-trixie-*.log`. La suite Python
completa y Docker x64/ARM64 son gates remotos antes del merge. La revisión
remota no es un gate: su falta de cuota no detiene el trabajo autorizado.

### Android AGP 9 · 2026-10-12

#351 (Trixie) se fusionó tras checks completos aprobados.

Toolchain Android: AGP 8.13.0 → 9.3.3 y Gradle 8.14.3 → 9.8.1 (última estable),
con wrapper regenerado y SHA-256 de la distribución y del JAR comprobados contra
services.gradle.org.

AGP 9.4.1 se probó y se descarta por ahora. Ejecuta las pruebas conectadas con
`android-test-engine` 1.0.1, fijado dentro del plugin, que separa
`android-test.instrumentation-args` por comas sin escape: `notClass=A,B,C` llega
al dispositivo como `notClass=A`, y un filtro `class=A,B` como `class=A`, sin
error. En la suite completa entraron LiveRestartTest y ReleaseUpdateTest, que
`scripts/android.py` excluye porque se ejecutan por fases externas, y fallaron
siete casos. Con AGP 9.3.3 el mismo comando conserva ambos valores y ejecuta
sólo la clase esperada. El engine 1.0.8 ya parsea comas escapadas; reabrir AGP
9.4+ cuando el plugin estable lo incluya y repetir la comprobación de
argumentos antes de cambiar la versión. Se retira el
plugin `org.jetbrains.kotlin.android`: AGP 9 compila Kotlin integrado y el
`jvmTarget` 21 pasa a `kotlin.compilerOptions`. Cambios de comportamiento de
AGP 9 tratados explícitamente: `resValues` vuelve a activarse (lo usa el nombre
de la APK de desarrollo) y `proguard-android.txt` deja de existir; se usa
`proguard-android-optimize.txt`, sin efecto mientras `minifyEnabled = false`.
El script de la app pasa a sintaxis de asignación, notación de dependencia de
una cadena y búsquedas explícitas en `rootProject.ext`: no quedan avisos de
Gradle 10 propios. Los restantes salen de AGP y de los build scripts generados
por Capacitor en `node_modules` y `capacitor-cordova-android-plugins`; se
resolverán con sus versiones.

compileSdk 36 → 37 (plataforma estable `android-37.0` en CI, doctor y docs);
minSdk 24 y targetSdk 36 no cambian, así que no se activan comportamientos
nuevos del sistema ni cambian los dispositivos admitidos. Con ello entra
OkHttp 5.5.0. Bibliotecas: CameraX 1.4.2 → 1.6.2, AndroidX activity 1.13.0,
appcompat 1.8.0, core 1.19.1, fragment 1.9.1, webkit 1.17.1, ZXing 3.5.4 y
org.json de pruebas 20260814. Capacitor sigue en 8 estable: 9 sólo existe como
alpha. Media3, Socket.IO, splashscreen, coordinatorlayout y test ya estaban en
su última versión estable.

Validación local: 65 pruebas JVM, lint (0 errores), APK de desarrollo y de
pruebas, y APK release firmada con un keystore temporal (`apksigner verify`;
minSdk 24, targetSdk 36, compileSdk 37 en el manifest). AVD API 36, suite
completa de `scripts/android.py integration` sin shards: 215 casos, 210
aprobados. Los cinco fallos son variantes TLS (CarLibrary, CatalogSearch,
Offline, Podcast y ProgramPcm). OfflineTest y ProgramPcmTest TLS fallan igual
en `main` (AGP 8.13, OkHttp 5.4) con el mismo filtro local; CarLibrary,
CatalogSearch y Podcast aprueban aislados en esta rama (7 de 7). Causa local:
el fixture TLS cierra una conexión keep-alive reutilizada y `OfflineStore`
descarga con `retryOnConnectionFailure(false)`, así que la copia queda en
`network` (`EOFException` al leer cabeceras). No es efecto de esta migración;
corregido aparte: la descarga offline descarta los sockets inactivos y repite
el GET una vez en un socket nuevo (ver `docs/android/EVIDENCE.md`). StartupTest, PlaybackTest y LiveListenerTest (HTTP/TLS)
aprueban 5 de 5. PairingTest, que usa CameraX, aprueba.
El gate remoto exige los cuatro shards Android en el último head de la PR.

Python 3.15 sigue pendiente: Docker Hub sólo ofrece `3.15.0rc3` y no existe
`python:3.15-slim-trixie`. Se reabre con la imagen estable. El resto de
dependencias directas Python, npm y Cargo estaba en su última versión
estable el 2026-10-12 (salvo parches diarios de boto3, que el rango admite).
