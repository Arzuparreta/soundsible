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

Pospuesto hasta evaluar cada beneficio, compatibilidad y coste:

- Python 3.15 y actualización de la base Debian.
- Vitest 5.
- AGP 9 + Gradle 9 + Kotlin integrado.
- OkHttp 5 y dirs 7.

No se elevan automáticamente los mínimos Android/iOS. Cada migración requiere
su validación funcional y de empaquetado; estar en latest no es un gate de
compatibilidad. AltStore PAL continúa sin verificar. No se publica una release
ni se modifica la versión de Soundsible en estos bloques.
