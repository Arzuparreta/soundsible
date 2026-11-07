# Portadas, adquisición y presupuestos de trabajo

Entrega iniciada desde `main` en `1d904020`, después de revisar el flujo de audio,
portadas y cachés, y validada con la base combinada de #423/#424 (`adff0c88`).
Antes de abrir la PR se incorporó también #425 (`9560a121`): solo retira el stub
`gui.sh` y actualiza el punto 8 de arquitectura, sin cambiar las fuentes ejecutadas
por las suites anteriores. Esa retirada no forma parte del diff de esta PR.
El original visual continúa separado del archivo de audio:
una imagen grande no vuelve a bloquear la primera muestra en su cabecera.

## Diagnóstico y recorrido de las peticiones

La función histórica no había desaparecido. PR #113 redujo la imagen incrustada
y eliminó vídeo innecesario; PR #171 conservó originales durables, variantes y
recuperación posterior. El contrato encontrado no era «un GET pide audio y JPEG
mínimo y siempre los sustituye»: audio, imagen visible y recuperación eran
operaciones independientes. Esta entrega conserva esa separación.

El síntoma tenía dos causas distintas: biblioteca y preview podían elegir
imágenes de procedencia diferente, y una miniatura 1280×720 solo aporta como
máximo 720×720 al recortarla cuadrada. Una pantalla a DPR 3 puede necesitar más.
Los endpoints consultados para las imágenes pequeñas de la muestra no ofrecían
una mejora confirmada. Ampliarlas o relajar el comparador no crea detalle.

| Momento | Peticiones y trabajo finales |
| --- | --- |
| Cargar biblioteca | `/api/library` entrega metadatos/revisiones/dimensiones/scope, no imágenes. Conserva 304 y deltas. |
| Escuchar audio adquirido | `/api/static/stream/<id>`, posiblemente varias peticiones Range. No consulta YouTube para obtener la portada. |
| Mostrar portada adquirida | `/api/static/cover/<id>` sirve original o variante local. Si aún falta el master, puede extraer la imagen local incrustada. No hace GET remoto en esta ruta. |
| Mostrar escenario NORMAL/DJ | `CoverImage` construye `srcset` según slot, DPR y resolución efectiva. No descarga todos los tamaños; el navegador selecciona uno. Media Session puede pedir su propia variante. |
| Buscar/escuchar preview | El proveedor/yt-dlp resuelve metadatos y audio; una llamada de extracción puede hacer varias peticiones HTTP. Se aprovechan candidatos ya presentes, sin una nueva extracción visual. Los bytes de la imagen requieren su GET normal. |
| Preparar preview | Se conservan memo/singleflight, expiración del stream firmado y caché progresiva existentes. Los status ya consultados transportan opcionalmente artwork; no se añaden polls. |
| Adquirir | yt-dlp CLI obtiene audio y metadatos con thumbnail incrustada; la reparación preserva el original antes de reducir la cabecera. Se mantiene el hash posterior al etiquetado. Una preview existente no se promociona con el contrato actual. |
| Guardar desde álbum de catálogo | Se revalida el registro Deezer para ligar edición e imagen a un receipt. Es una consulta de autoridad deliberada, no una descarga de imagen en el camino de audio. |
| Completar adquisición de catálogo | La pertenencia de audio se confirma antes de procesar la imagen. La cola guarda la intención durable antes de cerrarse; el recuperador descarga el candidato aparte. |
| Recuperar biblioteca antigua | Un recuperador secuencial por instancia conserva/revisa fuentes conocidas. Negativos y backoff evitan repetir el GET en cada play; nueva evidencia o reevaluación pueden habilitarlo. |

La antigua búsqueda tomaba `thumbnail` e ignoraba `thumbnails`; el resolver
descartaba las imágenes al conservar solo el stream. El recuperador comparaba
el lado menor con 1280: una fuente 1280×720 podía provocar otro GET de sí misma.
Los estados finales impedían reintentar incluso fallos temporales. Además, tres
variantes cuadradas grandes de una fuente 480×360 podían almacenar el mismo
JPEG con claves diferentes. Las correcciones siguientes atacan esas pérdidas
y duplicaciones concretas.

## Qué permite yt-dlp

`extract_info(download=False)` obtiene metadatos/formatos sin descargar el audio;
no implica una sola petición de red. `thumbnail`/`thumbnails` permiten reutilizar
referencias, aunque el extractor también construye URLs especulativas. Dimensiones
declaradas y procedencia se conservan como observaciones sin verificar.

`--write-thumbnail` guarda una imagen aparte; `--skip-download` evita el audio
pero no la extracción necesaria. `--list-thumbnails` inspecciona referencias,
`--embed-thumbnail` las incrusta y `--convert-thumbnails` cambia su formato.
Ninguna opción crea detalle. Pedir todas las miniaturas o hacer otra extracción
solo para descubrirlas aumentaría solicitudes. Tampoco existe un GET ordinario
que entregue a la vez audio y un JPEG independiente. La portada se descubre en
respuestas ya necesarias y se descarga por su consumidor visual independiente.

Referencias: [opciones de miniaturas](https://github.com/yt-dlp/yt-dlp#thumbnail-options)
y [argumentos del extractor](https://github.com/yt-dlp/yt-dlp#extractor-arguments).
Los nombres y formatos ofrecidos dependen del extractor/proveedor vigente; el
fallback de audio continúa siendo necesario.

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
  por páginas y los cambios de identidad copian solo las pendientes de la cuenta.
  El receipt se contrasta con el vídeo actual de la pista entrante. El job sigue
  siendo reproducible hasta persistir esa intención, también tras el commit de biblioteca.
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
  sesión pública en un hijo HTTP perezoso separado del transformador. Solo admite
  un trabajo; la saturación aplaza sin contacto ni consumir intento. El padre
  supervisa el plazo completo desde antes de admisión, incluidos arranque, DNS,
  TLS y cabeceras; parada o timeout matan y recogen el hijo y lector IPC.
  `Retry-After` pausa el host de forma durable y un 404 conserva un negativo.
  El cuerpo va por staging con límite de bytes y cuatro millones de píxeles.
  Al plazo operativo se suma el margen acotado de recogida del proceso; no se
  promete interrumpir instantáneamente una operación del kernel.
- En el motor gevent, un hijo perezoso valida originales nuevos y transforma
  variantes. El padre conserva cuota, publicación atómica y descriptores abiertos.
  Un hit caliente no espera al hijo ni consulta SQLite si su metadata está
  reciente. Los buckets equivalentes comparten bytes y clave. Cola y espera
  comparten deadline, también al esperar la cuota con locks no bloqueantes y
  pausas cooperativas. No hay fallback de Pillow al hub tras fallar el hijo.
  El staging está en caché y tiene leases de padre/escritor y reconciliación tras
  crash. El hijo limpia su último resultado al perder al padre, tiene watchdog
  por trabajo y se recoge por inactividad/apagado. La comparación perceptual
  antigua sigue siendo local: no se afirma haber aislado todo cálculo visual.
  Puede haber dos intérpretes visuales; no se afirma que su RSS sea gratuito.
  Estos límites son fijos, no proporcionales a los núcleos: un Pi evita
  multiplicar decodificadores y el desktop conserva el hub disponible. No hay
  evidencia física de Pi ni ajuste automático que prometa el óptimo de cada host.
- El visitor de YouTube tiene cooldown, renovación y rechazo sin cola por configuración
  efectiva de egress. Un rechazo antiguo no invalida un identificador nuevo.
  Las cachés de streams distinguen relay A y B mediante una huella sin guardar
  sus credenciales en la clave.
- Una descarga tiene presupuesto único entre intento nativo, cookies y fallback.
  Incluye stdout silencioso, salida sin newline, espera, descendientes y
  FFprobe/remux posteriores, que comparten el primer deadline. La
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

La tercera crítica reprodujo cierres parciales y carreras adicionales:

| Hallazgo | Disposición |
| --- | --- |
| Rekey personal copiaba elecciones ajenas | Copia de overrides/receipts limitada a la cuenta activa; regresión Alice/Bob. |
| Lock de cuota bloqueaba el hub y excedía plazo | Locks de archivo no bloqueantes, espera cooperativa y deadline hasta publicación; sonda gevent real. |
| Receipt de vídeo anterior sobrevivía al cambio de contenido | Se retira al contrastarlo con el vídeo actual; la adopción recibe esa identidad actual. |
| FFprobe/remux fuera de cancelación | Runner común con presupuesto heredado entre etapas; cancelación y timeout reales. |
| Trickle de cabeceras eludía plazo | Cuarta crítica de diseño recomendó hijo HTTP separado, con una admisión, supervisión y kill/reap. DNS/cabeceras/cuerpo/parada cubiertos. |
| Fallback incompleto en CSS | Las filas pequeñas mantienen el thumbnail; las superficies CSS grandes conservan la imagen previa como capa. Prueba del componente real de fila. |
| Crash perdía intención después de incorporar audio | Persistencia antes de completar el job y replay tras commit; crash/error SQLite cubiertos sin redescargar ni resucitar una pista eliminada. |

La última revisión comprobó el cierre de los siete hallazgos y no encontró
otros bloqueantes confirmados. Reprodujo además la espera SQLite de `observe`
en el camino de audio: un escritor externo retrasaba también el hub. El commit
`f8587f4d`, preparado durante esa revisión, cambia esa observación opcional a
`timeout=0`; el revisor verificó su salida inmediata. Sus 15 pruebas seleccionadas
pasaron. Validó estáticamente el proceso HTTP separado, admisión única,
supervisión, lector IPC y leases. No ejecutó las suites largas ni acreditó
Windows frozen con tráfico real, bloqueo TLS específico, WebKit o Pi.

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
| Lote frío completo | 363,56 ms | 207,69 ms |
| HTTP p95 del lote frío | 362,24 ms | 204,38 ms |
| Retraso máximo del hub, frío | 300,47 ms | 21,92 ms |
| CPU del **padre**, lote frío | 189,19 ms | 52,87 ms |
| Lote caliente completo | 28,58 ms | 29,76 ms |
| HTTP p95 del lote caliente | 28,43 ms | 29,45 ms |

Los cuerpos son idénticos en todos los casos. El aislamiento reduce el trabajo
CPU dentro del servidor, no demuestra menor CPU total: la CPU del hijo no está
en esa columna. El lote caliente añade unos 1,2 ms; no se afirma que toda
petición sea más rápida. La mejora relevante es no monopolizar el hub durante
el lote frío y conservar la selección por cuenta. Son medidas de este equipo,
no una garantía para otros discos, Pi o reproducción musical.

Datos y reproducción: [JSONL](../performance/artwork-pipeline-results.jsonl),
`python scripts/benchmark_artwork_pipeline.py --baseline 1d904020 --repeats 5`.

### Validación local y gates pendientes

- Regresión principal inicial: 2645 aprobadas y dos omisiones; una expectativa
  de payload no incluía el nuevo scope y el worktree no tenía el modelo ONNX
  incluido. Se corrigió la expectativa y se preparó la copia pública verificada
  del modelo; los 17 casos de ese radio pasaron. La regresión completa sobre la
  base combinada terminó con **2674 aprobadas y una omisión**, en 626,55 s.
- Regresión tras la tercera crítica: 117 aprobadas; radio adicional de identidad/procesos/replay: 66 aprobadas. La segunda ejecución principal completa, con el nuevo transporte, termina con **2688 aprobadas y una omisión**, en 594,08 s. Los cambios pequeños posteriores de observación/visitor/lector tienen sus radios finales aprobados (57, 50 y cuatro casos).
- Cliente combinado final: TypeScript y **1871 pruebas aprobadas** en 228 archivos.
- Chromium final completo: **384 aprobadas y 74 omisiones** entre móvil/escritorio, en 3,6 min. Una pasada anterior con el grafo de Vite ya modificado falló en ocho casos de estado/imports; tras reiniciar servidor, pasan los diez casos de ese radio y la suite completa, sin cambiar sus aserciones.
- Android combinado: preparación, APK debug, JVM y lint aprobados. Device panel no detecta SDK; no se
  presenta como aceptación de ejecución del emulador ni escucha física.
- Contratos de procesos/worker: 37 casos aprobados en la suite de pipeline;
  radio posterior de audio/observación: 57 aprobados y cuatro pruebas de lector/contención aprobadas. La observación opcional usa SQLite sin espera para no retener audio. Los jobs existentes de Windows x64/ARM64 los ejecutan también
  y usan el sidecar construido para probar el entrypoint visual frozen; sus
  resultados remotos siguen pendientes.
- WebKit final completo: **371 aprobadas y 87 omisiones** entre móvil/escritorio, en 7,1 min, Docker con montaje de solo lectura y un worker; ejecutado después de Chromium y de la carga Python. Servidor Vite de pruebas detenido.
- Ruff y comprobación de manifests aprobados. CI del último head sigue siendo gate de entrega. No se ha fusionado ni publicado esta implementación.
- Primer CI remoto: shards Android 2/5 fallaron antes de ejecutar la app, al
  perder ADB durante la preparación Wi-Fi. Se acotó la recuperación de ese único
  comando y se añadieron cuatro regresiones (ocho pruebas del módulo aprobadas).
  Diagnóstico y límites en `docs/android/CI_DIAGNOSTICS.md`. No se ocultan ni se
  reintentan automáticamente pruebas de producto; se exige CI completo del nuevo head.
- Windows x64 ejecutó los contratos del sidecar, pero la prueba de descendiente
  no reconoció el handshake: el runner binario conservaba `\r` de CRLF en los
  callbacks. Se restauró el contrato de líneas sin terminadores y se añadió una
  regresión de bytes CRLF ejecutable también en Linux, manteniendo la aserción
  real de cancelación y cierre del descendiente.
