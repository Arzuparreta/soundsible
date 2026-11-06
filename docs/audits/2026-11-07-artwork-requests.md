# Portadas, adquisición y presupuestos de trabajo

Entrega desde `main` en `1d904020`, después de revisar el flujo de audio,
portadas y cachés. El original visual continúa separado del archivo de audio:
una imagen grande no vuelve a bloquear la primera muestra en su cabecera.

## Contratos

- Las búsquedas usan `thumbnails` cuando traen dimensiones, sin otra consulta
  de descubrimiento. Se excluyen fotogramas alternativos; dimensiones declaradas
  no equivalen a una descarga verificada. El resolver conserva candidatos
  públicos seguros en SQLite, independientemente de la caducidad del stream.
- La preparación/status ya existente transporta esas referencias. La web solo
  mejora una miniatura principal del mismo vídeo y conserva la anterior si
  falla. No cambia una portada de catálogo por una imagen de vídeo ni aumenta
  el prefetch o el número de polls.
- Al guardar una canción desde un álbum de Deezer, el servidor revalida el
  registro, artista, título y álbum. Emite un receipt autenticado que liga la
  URL canónica a la cuenta, vídeo, registro e intención ordenada. Una URL o
  identidad de edición enviada por el cliente no es autoridad de descarga.
- El audio se incorpora antes de programar esa selección opcional. La intención
  durable se procesa por el recuperador existente, con lease por intento,
  pausas persistidas y lotes acotados. Publicar la portada y completar el intento
  comparten transacción. Una intención antigua o un resultado tardío no puede
  sustituir una nueva, manual o retirada. Las selecciones huérfanas se retiran
  por páginas y los cambios de identidad copian las pendientes.
- Objetos por hash y portada de fuente son compartidos. Selecciones y overrides
  pertenecen a una cuenta. `none` es un tombstone. Las referencias globales
  manuales históricas se conservan: no se inventa a quién pertenecían.
- Los clientes reciben un scope visual por cuenta. Las variantes versionadas
  conservan ETag y retención privada; las URLs sin revisión y placeholders
  revalidan. Saturación, timeout y crash son 503 con `no-store`, no una portada
  ausente cacheada durante un día. Subsonic respeta la referencia efectiva.
- La recuperación distingue el techo conocido de fuente del detalle que necesita
  una pantalla. Una fuente conocida de 1280×720 no provoca otro GET por no llegar
  a 1280 en su lado menor. Una imagen o candidatos nuevos reabren la evaluación;
  los negativos y pausas sobreviven reinicios. Se mantienen aspecto y pHash
  conservadores: no son prueba de identidad de edición.
- Las descargas visuales solo aceptan HTTPS de hosts/rutas concretos, sin
  redirects, cookies de usuario, netrc ni proxy ambiental. Reutilizan una única
  sesión pública. `Retry-After` pausa el host de forma durable y un 404 conserva
  un negativo. Lecturas parciales comprueban el plazo y parada; hay un límite
  de bytes y de cuatro millones de píxeles en imágenes remotas automáticas.
  El límite de inactividad de una lectura también acota la reacción a la parada;
  no se promete interrumpir instantáneamente una operación de red del sistema.
- En el motor gevent, un hijo perezoso valida originales nuevos y transforma
  variantes. El padre conserva cuota, publicación atómica y descriptores abiertos.
  Un hit caliente no espera al hijo ni consulta SQLite si su metadata está
  reciente. Los buckets equivalentes comparten bytes y clave. Cola y espera
  comparten deadline; no hay fallback de Pillow al hub tras fallar el hijo.
  El staging está en caché y tiene lease entre procesos y reconciliación tras
  crash. El hijo limpia su último resultado al perder al padre, tiene watchdog
  por trabajo y se recoge por inactividad/apagado. La comparación perceptual
  antigua sigue siendo local: no se afirma haber aislado todo cálculo visual.
- El visitor de YouTube tiene cooldown y renovación sin cola por configuración
  efectiva de egress. Un rechazo antiguo no invalida un identificador nuevo.
  Las cachés de streams distinguen relay A y B mediante una huella sin guardar
  sus credenciales en la clave.
- Una descarga tiene presupuesto único entre intento nativo, cookies y fallback.
  Incluye stdout silencioso, salida sin newline, espera y descendientes. La
  vigencia real del item/attempt y el apagado llegan al runner y a las fases
  posteriores; cancelar no deja el slot consumiendo red otros diez minutos.
  POSIX usa grupo de procesos; Windows asigna un proceso suspendido a un Job
  con KILL_ON_JOB_CLOSE antes de reanudar su hilo principal. El diagnóstico es
  un ring por bytes y las causas de retry no se pierden por rotación.
- Android y la API del coche piden una variante cuadrada de 640; iOS usa
  NSCache con coste de imagen y límite de entradas. NSCache es una política de
  expulsión, no una garantía física de memoria total del proceso.

## Decisión de alcance: promoción de audio

No se habilita promoción de previews a adquisición. La caché actual no prueba
la equivalencia con el selector de adquisición ni la completitud para todos sus
caminos. Se conserva la descarga normal. Activarla requiere un contrato nuevo
que ate generación, integridad, formato seleccionado y política de calidad,
además de mediciones completas. Es una decisión de corrección respaldada por
las dos críticas de sistemas, no un ahorro de red conseguido.

Tampoco se introduce Redis, un scheduler global, workers por número de núcleos,
un barrido de previews ni relajación de la comparación visual. Los límites
existentes de disco, audio CDN y análisis DJ siguen siendo independientes.

## Crítica e iteración

Se solicitaron críticas de sistemas con `gpt-6.1-sol` y esfuerzo `xhigh`.
La primera bloqueó las selecciones globales y la promoción sin evidencia;
se incorporaron aislamiento y autoridad de fuente. La segunda encontró:

| Hallazgo | Disposición |
| --- | --- |
| Subsonic recuperaba una portada retirada | El extractor consulta primero override/tombstone efectivo; regresión. |
| Trickle eludía plazo visual | Lecturas parciales y presupuesto desde antes de abrir; servidor lento real. |
| Cancelación no llegaba al downloader | Contexto explícito item/attempt/parada; hijo y descendientes reales. |
| Replays concurrentes alteraban éxito | Claim durable y publicación/completado en una transacción. |
| Huérfanas bloqueaban el lote | Paginación con limpieza y remap de selecciones. |
| Error temporal cacheaba placeholder | 503 privado no-store con Retry-After. |
| Deadline empezaba tras un lock | Plazo creado en admisión y propagado al hijo. |
| Crash retenía staging durable | Staging de caché, lease y reconciliación; EOF/watchdog del hijo. |
| Doble decode en el hub | Validación de master fuera del hub; límite remoto menor y hits sin decode. |
| Upgrade fallido quitaba portada | Fallback a la portada anterior y negativo acotado de sesión. |

## Evidencia y límites

Las pruebas y mediciones finales de esta entrega se registran aquí antes de
abrir la PR. `scripts/benchmark_artwork_pipeline.py` compara peticiones HTTP
frías/calientes y retraso del hub con una revisión git, sobre el mismo corpus,
encoder y disco, en runtime temporal. No toca bibliotecas reales.

Una mejora de respuesta del hub no equivale a menor latencia de cada imagen:
IPC, staging y arranque del hijo añaden costes que se deben informar. Las
mediciones del desktop no prueban Raspberry Pi, batería, escucha física ni
aceptación de Windows/macOS. La ejecución del entrypoint del worker en Python
no equivale por sí sola a probar un binario frozen.

### Medición HTTP aislada

Ryzen 7 5800X, Linux, mismo disco; cinco repeticiones, doce peticiones
simultáneas a la ruta real de cover, imágenes sintéticas de 1280×720 y variante
cuadrada de 960. Cuenta ligada por petición. Solo se sustituyen biblioteca y
fuente de archivos, sin servicio ni biblioteca reales. El proceso visual está
arrancado antes del lote frío; no se incluye su primer arranque. Medianas de
los lotes; la columna de hub es la mediana del máximo observado en cada lote:

| Operación | Base | Pipeline |
| --- | ---: | ---: |
| Lote frío completo | 323,01 ms | 198,34 ms |
| HTTP p95 del lote frío | 322,84 ms | 195,73 ms |
| Retraso máximo del hub, frío | 262,67 ms | 17,88 ms |
| CPU del **padre**, lote frío | 176,34 ms | 49,68 ms |
| Lote caliente completo | 26,05 ms | 29,38 ms |
| HTTP p95 del lote caliente | 25,91 ms | 28,53 ms |

Los cuerpos son idénticos en todos los casos. El aislamiento reduce el trabajo
CPU dentro del servidor, no demuestra menor CPU total: la CPU del hijo no está
en esa columna. El lote caliente añade unos 3,3 ms; no se afirma que toda
petición sea más rápida. La mejora relevante es no monopolizar el hub durante
el lote frío y conservar la selección por cuenta. Son medidas de este equipo,
no una garantía para otros discos, Pi o reproducción musical.

Datos y reproducción: [JSONL](../performance/artwork-pipeline-results.jsonl),
`python scripts/benchmark_artwork_pipeline.py --baseline 1d904020 --repeats 5`.

### Validación en curso

- Regresión principal inicial: 2645 aprobadas y dos omisiones; una expectativa
  de payload no incluía el nuevo scope y el worktree no tenía el modelo ONNX
  incluido. Se corrigió la expectativa y se preparó la copia pública verificada
  del modelo; los 17 casos de ese radio pasaron. Se repetirá la regresión sobre
  la base combinada antes de abrir la PR.
- Última regresión de portada, adquisición, HTTP y cachés: 181 aprobadas.
- Cliente: TypeScript y 1864 pruebas aprobadas antes de incorporar la base nueva.
- Android: APK debug, JVM y lint aprobados. Device panel no detecta SDK; no se
  presenta como aceptación de ejecución del emulador ni escucha física.
- Los cuatro perfiles completos de navegador y CI del último head siguen siendo
  gates de entrega. No se ha publicado ni fusionado esta implementación.
