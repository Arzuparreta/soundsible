# Limpieza de código heredado sin consumidores

Base inspeccionada: `origin/main` en `4131f7f0`. El usuario pide conservar el
comportamiento actual y dejar una PR abierta, sin merge. El alcance se fija
mediante referencias, imports, puntos de entrada, documentación y pruebas;
la ausencia de una llamada dentro de la aplicación no basta para borrar una
API pública, un comando CLI o una herramienta de reproducción de resultados.

## Cambios

- **Carátulas:** el extractor conserva el original y su incorporación al store.
  Se retiran la generación de `*_thumb.jpg` y sus dos lectores sin llamadas.
  Las respuestas siguen usando las variantes de `ArtworkStore`, con sus mismas
  dimensiones, revisión, cuota y descriptor abierto. No se borran archivos
  existentes ni se cambian referencias de originales.
- **Diagnóstico:** la captura automática de producción entrega y persiste las
  mismas filas, pero no retiene además el historial manual de 4.096 eventos.
  La captura manual y el modo de desarrollo conservan ese historial para las
  pruebas de navegador y diagnóstico. Secuencias, batches, reintentos, pérdidas,
  ACK, aislamiento de cuenta y opt-out conservan sus contratos.
- **DJ:** se retira `shared/dj_library.py`, cuyo arranque se había eliminado en
  P14, junto con sus tres pruebas históricas y el monkeypatch global inactivo.
  Los trabajos de sesiones, el proceso analizador, la versión de análisis y las
  medidas musicales permanecen intactos.
- **Orquestador:** se retiran `submit_metadata` y su executor sin envíos de
  producción. El pool de fondo, el supervisor y `run_serialized` conservan sus
  límites y bloqueo. La forma del snapshot de recursos conserva la entrada
  `metadata` con los ceros que ya devolvía en producción.
- **Reproductor local retirado:** se eliminan la variable siempre `None` y sus
  ramas imposibles. `get_core` conserva la terna con `None` en segunda posición.
  Las rutas públicas de play/toggle mantienen sus errores 404/500 y los agentes
  sin dispositivo mantienen 409. El control remoto y el beacon de primer play
  siguen disponibles por sus caminos actuales.
- **Frontend:** se retiran los módulos desconectados `trackResolution` y
  `mobile/catalogProgram`, wrappers API sin llamadas, sus tipos exclusivos,
  conversiones antiguas de resultados, el estado de cola móvil que nadie abría,
  dos iconos y helpers sin consumidores. Los endpoints del servidor, la
  migración por trabajos y la resolución diferida de colecciones se conservan.
- **Helpers Python:** se retiran los métodos sin referencias de desconexión de
  almacenamiento, consulta de álbum por nombre, cálculo de tamaño de bucket,
  calentamiento de streams y downloader, executor de resolución, mapeo de ruta
  a usuario, petición admin, sesiones, socket activo, uso de caché y dos helpers
  del launcher.

Se conservan los comandos `python -m shared.instance_backup`, el helper de
parada del engine utilizado por el smoke, las entradas de reproducción de la
comparativa de detectores y las funciones usadas para inspeccionar estado en
pruebas. No se añaden migraciones ni se modifican datos de usuario.

## Fallo de Desktop Build en main

Run [41502159498](https://github.com/Arzuparreta/soundsible/actions/runs/41502159498):
los binarios, instaladores y smoke del sidecar se construyeron correctamente.
El smoke UI x64 agotó la espera con la ventana WebView en blanco; ARM agotó la
espera de un botón con el OOBE de privacidad de Windows delante. Después ARM
falló también al consultar Rekor con un timeout de red.

El smoke usa renderizado software de WebView2 solo en su proceso de prueba,
espera controles listos y atiende OOBE durante todas esas esperas, no únicamente
tras abrir el selector de carpetas. Los fallos adjuntan los árboles UIA además
de la captura. Dos pruebas aisladas cubren el OOBE/arranque tardío y que los
errores UIA inesperados no se oculten.

La atestación reintenta una vez. Si el segundo intento falla, falla el job;
no se suprime la atestación ni se publica un instalador sin ella. La ejecución
real Windows se comprueba en la PR; este equipo Linux no sustituye esa prueba.

## Validación

Las comprobaciones se ejecutan con runtimes y servidores de prueba aislados.
No se reinicia el motor del usuario ni se utiliza su biblioteca.
La PR registra el resultado final de Python, frontend, los cuatro perfiles de
navegador, lint y los checks remotos del último head.
