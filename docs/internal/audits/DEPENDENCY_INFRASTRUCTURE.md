# Bloque 2 · Infraestructura de dependencias

Validada inicialmente por separado en PR #346, sobre main tras la PR #345.
Se incorpora al conjunto de clientes/Python en PR #347 para validar y fusionar
un solo head combinado. No despliega servicios ni publica releases.

## Cambios

- Actions: checkout 7.0.1, setup-node 7.1.0, setup-python 7.0.0,
  setup-java 6.0.1, cache 6.1.0, upload-artifact 7.0.2,
  download-artifact 8.0.2 y attest-build-provenance 4.2.2.
- Docker Actions: buildx 4.4.1, QEMU 4.4.0, login 4.6.0,
  metadata 6.2.0 y build-push 7.4.0. También paths-filter 4.0.3,
  setup-gradle 6.4.0, setup-android 4.0.4, emulator-runner 2.38.0,
  rust-cache 2.9.2 y action-gh-release 3.0.3. Se conservan los inputs,
  permisos y gates de los workflows; no se migra Gradle/AGP.
- MediaMTX 1.21.2 en Compose y en el fixture Android, con el SHA-256 del
  archivo oficial Linux x64 actualizado conjuntamente.
- Coturn 4.18.0-r0 en los tres servicios. Esta versión elimina `--no-dtls`:
  DTLS ahora está desactivado por defecto y sólo se activa con `--dtls`.
  Se retira la opción eliminada sin activar DTLS. CLI también queda apagada
  por defecto. Referencia: [notas de 4.18.0](https://github.com/coturn/coturn/releases/tag/4.18.0).
- FFmpeg de la línea 8.1, build mensual 8.1.3 del 30 de septiembre, en CI
  y en el empaquetado desktop, excepto Windows ARM64. El build nuevo falla
  en el smoke nativo al generar audio FLAC con STATUS_ACCESS_VIOLATION
  (run 38149650880); ese target conserva el pin 8.1.2 ya verificado de julio.
  Se verificaron los hashes de los cuatro candidatos Linux/Windows, x64/ARM64;
  un checksum correcto no demuestra compatibilidad del binario. Linux deja de descargar un master flotante sin checksum;
  ARM64 selecciona su archivo correcto. FFmpeg 9 queda fuera de esta entrega.

## Validación local

- actionlint 1.7.12 sobre todos los workflows; sintaxis Bash, Ruff del fixture,
  `docker compose config --quiet` y `git diff --check` aprobados.
- Descarga y SHA-256 de los cuatro archivos FFmpeg comprobados. El script de
  empaquetado instala ffmpeg/ffprobe Linux x64; 10 pruebas de runtime y
  loudness aprobadas usando esos binarios. Windows se valida mediante CI.
- MediaMTX arranca con la configuración real de LiveFixture y sus certificados
  efímeros. La API devuelve 200; Community devuelve health 200 con SQLite y
  MediaMTX saludables, usando los pins Python nuevos del bloque 2.
- Coturn en contenedores aislados, escuchando sólo en loopback: autenticación
  TURN REST HMAC, asignaciones exclusivamente relay y tráfico bidireccional
  aprobados por UDP, TCP y TLS. TLS verifica el certificado con la CA efímera;
  la clave tiene los permisos de lectura documentados para el contenedor.
  La primera prueba detectó la opción eliminada y se corrigió antes de abrir
  la PR. No se usan credenciales ni servicios de producción.

Los checks del último head de la PR deben aprobar antes de dar esta entrega
por terminada. Los cuatro shards Android comprueban el relay nuevo por HTTP/TLS;
Desktop Build comprueba los binarios Windows. Actualizar las Actions de releases
no ejecuta una release local ni prueba los permisos de una publicación real.
AltStore PAL continúa sin verificar: no existe la cuenta Apple de pago necesaria
para ejecutar ese camino y sus avisos se conservan.
