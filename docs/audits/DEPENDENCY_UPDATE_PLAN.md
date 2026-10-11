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
| Python | cryptography 50.0.2, Werkzeug 3.1.9, urllib3 2.8.0 y Flask 3.1.3 como mínimos seguros. |
| Comunidad | Flask 3.1.3, Werkzeug 3.1.9 y cryptography 50.0.2; Flask-SocketIO 5.6.1 por compatibilidad con el RequestContext de Flask corregido. |
| Sidecar | yt-dlp 2026.8.19, igual que requirements.txt. |
| npm | Vitest 4.1.11 en los dos clientes; Solid 1.9.17 permite seroval/seroval-plugins 1.6.9. Locks con los patches compatibles de los transitivos afectados y sus dependencias. |
| Rust | rustls 0.23.42 → 0.23.45 y rustls-webpki 0.103.13 → 0.103.15; resto del lock conservado. |

### Avisos que no se resuelven forzando versiones

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

Pendiente; no incluido en la primera PR:

- Actualizar Vite, Playwright y su imagen, Capacitor y la familia Tauri de forma
  coordinada; revisar los avisos transitivos de mantenimiento que sigan abiertos.
- Actualizar los demás paquetes Python dentro de las líneas compatibles.
- Unificar la herramienta Node del proyecto en la LTS elegida y declarar sus
  requisitos; Node/npm del equipo ya están actualizados. Seleccionar JDK 21
  sólo para Android; no cambiar el Java global.
- Revisar Actions, MediaMTX, coturn y los pins/checksums FFmpeg en entregas
  separadas con pruebas de la plataforma afectada.

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
