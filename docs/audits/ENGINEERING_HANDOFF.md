# Traspaso de la optimización de recursos de Soundsible

Punto de entrada para continuar con otro agente sin el historial del chat.
Estado verificado al preparar este documento: rama `fix/sqlite-connection-lifecycle`,
último chunk funcional `32929f7`. Este traspaso se incorpora en un commit posterior.

## Instrucciones del usuario que siguen vigentes

- Trabajar en **esta misma rama, chunk por chunk**. No abrir PR contra `main`
  hasta que esté terminado todo el trabajo de la auditoría y el usuario lo indique.
- Cada implementación completa termina con un commit enfocado. No hacer push
  salvo petición explícita: el usuario viene haciendo los pushes.
- Priorizar menos recursos sin eliminar funcionalidades. Evitar retener datos
  en RAM cuando no necesitan acceso inmediato; preferir SQLite/disco y buffers
  acotados. No añadir copias persistentes de la biblioteca en memoria.
- Planear y completar cada chunk de extremo a extremo: reproducción, cambio,
  pruebas pertinentes, medición cuando corresponda, documentación y commit.
- Respetar `AGENTS.md`: no commits a main, no editar versiones manualmente y
  **no ejecutar `npm run build`**. El gate del cliente es `cd ui_web && npm test`.
- No delegar a subagentes sin autorización explícita. No se han usado en estos chunks.
- Comunicar en español. No exigir al usuario repetir el contexto disponible aquí.

## Auditoría original y significado de sus resultados

- [Informe original](2026-09-20-engineering.md).
- [Reproductor original](reproduce_resource_review.py).
- Procedencia: commit `0baebe3ef8048ae4d9764a8d55b1ef2897407755`, rama original
  `audit/engineering-resource-review`. Ambos archivos se recuperaron literalmente
  con `git show`; **no estaban en el árbol de la rama de implementación**.

El informe es evidencia histórica, no una descripción actual de todos los fallos.
No ejecutar su reproductor esperando que reproduzca problemas ya corregidos.
Su sugerencia de PR por entrega queda reemplazada por la instrucción del usuario:
una rama de trabajo, sin PR todavía. El informe no prueba ahorro durante escucha.

## Chunks ya completados

Los hashes identifican cambios reales de esta rama, no propuestas:

| Commit | Entrega |
| --- | --- |
| `807926a` | Devolver conexiones SQLite al terminar cada bloque; resolver el agotamiento del pool y el fallo de factory. |
| `773470a` | Construir payload público directamente; consultas de artwork por IDs. |
| `8c2423f` | Acotar retención y controlar el ciclo de vida del prefetch. |
| `e6b1a4e` | Acotar almacenamiento, persistencia y envío del outbox de trazas. |
| `a8241fb` | Reutilizar puntuaciones de entidades y selección top-k en catálogo local; todavía recorre todas las canciones. |
| `93902d4` | Revisiones/ETags por cuenta y revalidación sin reconstruir el cliente. |
| `bcf4fbf` | 304 temprano a partir de dependencias públicas sin materializar la respuesta. |
| `2ad6db3` | Deltas con historial de hashes en disco, cuotas y aplicación incremental en cliente. |
| `5e7994d` | Escrituras canónicas incrementales y staging SQLite acotado; conservar revisiones, aliases, fechas y estado de usuario. |
| `cd2311b` | Calcular hash/tamaño del JSON completo por lotes cuando solo se envía un delta. |
| `563d0c6` | Journals transaccionales acotados y preparación exclusiva de filas afectadas; cubre carátulas y volumen. |
| `e2efc64` | Corregir carrera de `Memo.resolve`: comprobar caché y elegir flight dentro del mismo bloqueo. |
| `c544318` | Cuota de variantes de artwork, índice en disco y descriptores abiertos para respuestas activas. |
| `bc90a83` | Candidatos de búsqueda local desde un índice SQLite verificado por huella; mismo ranker, resultados y orden; recorrido completo si no se puede demostrar. |
| `32929f7` | Exportación de `library.json` serializada una vez por bloques y copiada al resto de destinos; mismos bytes, permisos y durabilidad. |

Documentación y resultados reproducibles:

- [Selección local](../performance/local-catalog-selection.md),
  [revisiones](../performance/library-revisions.md),
  [deltas iniciales](../performance/library-deltas.md).
- [Escrituras incrementales](../performance/incremental-library-writes.md),
  [serialización acotada](../performance/library-delta-serialization.md),
  [deltas por journals](../performance/journal-library-deltas.md).
- [Coordinación Memo](../performance/memo-coordination.md),
  [cuota de artwork](../performance/artwork-variant-quota.md),
  [índice de búsqueda local](../performance/local-search-index.md),
  [exportación por bloques](../performance/library-export-streaming.md).
- Los JSONL de mediciones están junto a sus documentos en `docs/performance/`.
  Los scripts correspondientes viven en `scripts/benchmark_*.py`.

No mezclar números entre benchmarks: unos excluyen anotación/SQL y otros usan
stores reales; algunos comparan funciones antiguas cargadas desde git con helpers
actuales. Los documentos explican qué se incluyó. Ninguna cifra equivale a RSS
total, ahorro de energía, calidad de reproducción o aceptación acústica.

## Estado técnico que debe preservarse

### Biblioteca y deltas

- `replace_library()` conserva semántica de reemplazo lógico y transacción
  atómica. Una llamada exitosa incrementa revisión incluso sin cambios. Solo
  escribe filas que difieren; `expected_revision` se valida dentro de la transacción.
- Journals y hashes de fuente viven en SQLite, no en mapas de metadatos residentes.
  `shared/library_changes.py`, `shared/sqlite_changes.py` y
  `shared/api/library_incremental.py` implementan pruebas de fuente y selección.
- Los modelos siguen siendo mutables antes de guardarse. Las solicitudes parciales
  **todavía recorren la biblioteca para comprobar fingerprints**. No sustituir
  esas comprobaciones por confiar ciegamente en la revisión SQLite.
- ETags de fuentes canónicas verificadas son tokens opacos de dependencias,
  no hashes del JSON entero. El camino antiguo sigue para fuentes no verificadas.
- No romper aislamiento de cuentas, cambios durante copia/anotación, eliminación
  de campos, orden, rekeys/aliases, estado de usuario ni primera fecha `added_at`.
- Los journals tienen límites y épocas; si no se puede demostrar equivalencia,
  se envía la respuesta completa. No ocultar ese fallback como un fallo funcional.
- Coste conocido: mantener pruebas/journals hace más caros algunos guardados.
  Con 50k canciones, un benchmark dio guardado+petición de título 2,88 → 1,74 s,
  aunque el guardado aislado empeoró. No afirmar que toda operación es más rápida.
- "Importación inicial" significa insertar una biblioteca en base vacía; **no**
  cada arranque del motor, apertura del cliente o consulta de biblioteca.

### Artwork

- `SOUNDSIBLE_ARTWORK_CACHE_MB=512` por defecto, seleccionado por el usuario;
  `0` desactiva retención. Configuración documentada en `docs/CONFIGURATION.md`.
- Solo variantes JPEG generadas entran en la cuota; nunca originales ni refs.
  Índice `variants.sqlite3` en caché, separado del índice durable de artwork.
- `shared/artwork_variants.py`: contador de bytes, LRU aproximado con actualización
  de uso como máximo una vez/minuto, limpieza paginada, reconciliación inicial o
  tras interrupciones, locks de archivo entre procesos. No escaneo por hit.
- `ArtworkStore.open_variant()` devuelve descriptor abierto y metadatos. HTTP
  debe usarlo: una ruta devuelta por `variant()` puede ser expulsada antes de abrirla.
- Cuota cuenta JPEG retenidos. Índice, temporales y archivos borrados aún abiertos
  pueden consumir espacio adicional. Archivos que Windows no deje borrar se saltan;
  sin espacio admisible, servir temporalmente. La limpieza inicial puede demorar
  la primera imagen de una caché antigua grande.
- Windows: mecanismo implementado y borrado denegado simulado, **no validación
  nativa de Windows**. No presentarlo como comprobado en Windows.

### Búsqueda local

- `shared/library_search.py`: tabla `library_search` (por cuenta, en `library.db`)
  con posición y título/artista/álbum ya plegados como los compara el ranker, y
  `library_search_state` (válido, `VERSION`, huella y la marca `syncing` de `sync`).
- `_local_catalog()` usa el índice **solo** si, en una misma instantánea de
  lectura, el estado es válido, `VERSION` coincide y la huella de
  `(title, artist, album_artist, album)` del modelo en memoria es igual a la
  guardada. Si no (ediciones sin guardar, índice inválido, tabla ausente, error
  SQL, consulta no enlazable) recorre el modelo completo como antes. No quitar
  esa comprobación ni sustituirla por la revisión SQLite.
- La huella cuesta ~22 ms por consulta a 50k: es el suelo de este diseño. No
  incluye IDs a propósito; el ranker toma IDs y payload del propio modelo.
- El filtro SQL es un **superconjunto** de lo que puntúa (tokens como substrings);
  filas `loose` siempre candidatas. `_text_score`/`_score_folded` y el índice
  comparten `search_title`/`search_text`. Una prueba fija el código de
  normalización, `_score_folded` y el filtro a `INDEX_FORMAT`: si cambia, revisar
  la prueba de superconjunto y subir el formato si cambian los valores guardados.
- Mantenimiento solo desde filas SQLite confirmadas, dentro de `replace_library`
  y del esquema, en un savepoint: un fallo deja el índice inválido y **nunca**
  hace fallar una guarda. Triggers en la BD invalidan, borran filas obsoletas o
  fuerzan reconstrucción (escrituras ajenas de valores plegados). Guardas que no
  tocan campos de búsqueda ni orden no pagan nada.
- Coste medido a 50k: guardado con edición de título +194 ms (+18 %), baja en medio
  +456 ms (+18 %), alta +156 ms (+6 %); índice 4,4 MB; construcción única 1,3 s en
  el primer arranque tras actualizar (bajo el lock global de esquema). Consultas
  raras 250–265 → 29–41 ms; densas de 2 letras 197 → 143 ms. Ver el documento.
- Las consultas densas siguen puntuando en Python cada coincidencia; bajar más
  exigiría puntuar en SQL, lo que duplicaría el ranker. No se ha hecho.

### Exportación portable: último chunk

- Cada guardado canónico reescribe `library.json` por usuario, en
  `<music>/library.json` si la instancia no es multiusuario y en el espejo del
  proveedor. Antes se construía el documento entero **dos veces** (export y
  `provider.save_library`); ahora `LibraryMetadata.iter_json()` lo genera por
  bloques de 128 pistas una vez y el resto son copias byte a byte
  (`shared/atomic_file.py`). `to_json()` no cambia; una prueba exige igualdad
  exacta de bytes.
- Se conservan: temporal + fsync + rename en las copias propias, destinos no
  escribibles avisados una vez, orden de publicación. El espejo del proveedor
  local se reescribía **in situ** (mismo inodo, permisos, symlinks; sin fsync)
  porque `mkstemp` lo habría dejado en 0600 y roto enlaces. Después se sustituyó
  por un reemplazo atómico que conserva symlink y permisos: ver «Correcciones
  tras la revisión». Los proveedores remotos suben el mismo texto.
- Un lock por `LibraryManager` impide que dos exportaciones se crucen (Windows no
  deja reemplazar un archivo que otra exportación está leyendo). No hay
  validación nativa en Windows.
- Una línea INFO por exportación (bytes, copias, ms) para decidir con datos si
  agruparlas merece la pena.
- Medido: 50k pistas 2,47 → 1,92 s y pico 168,5 → 1,07 MiB; la biblioteca real
  del usuario (208 pistas, 719 KB, 60 % caché de podcasts) 107 → 100 ms, 2,2 →
  1,3 MiB. Bytes escritos iguales. A esa escala dominan los dos fsync.
- **Agrupar exportaciones no se hizo**: se recomendó no hacerlo tras medir y el
  usuario aprobó el plan con esa recomendación. Motivos: poco
  ahorro a su escala, ODST lee y reescribe `<music>/library.json` (alargar la
  ventana de datos de podcast viejos) y el debounce existente no vacía nada al
  apagar. Revisar solo con las líneas INFO de una instancia real grande.
- Hallazgos sin tocar: tres copias del mismo archivo en el mismo disco; ODST
  mantiene su propia `LibraryMetadata` completa en RAM y la serializa entera tras
  cada descarga. Su escritura ya es atómica: ver «Correcciones tras la revisión».

## Evaluación posterior: prioridad de análisis DJ (2026-09-22)

Se implementó la puerta de medición del siguiente candidato, **no un scheduler
nuevo**. Ver [decisión y reproducción](../performance/dj-queue-priority-gate.md),
`scripts/benchmark_dj_queue.py` y la caracterización Chromium
`ui_web/tests/browser/dj-refinement-audit.spec.ts`.

- Ruta actual de colecciones explícitas, gevent y análisis/FFmpeg/SQLite reales;
  candidatos y audio sintéticos, runtime temporal. Cinco repeticiones por caso,
  con instrumentación activada/desactivada, sin tocar el motor del usuario.
- Nueve, 18 y 36 análisis terminan en medianas de 0,45 / 0,85 / 1,55 s. En
  caliente no se solicitan nuevos análisis. Es evidencia de ese corpus y equipo,
  no latencia de escucha ni ahorro de recursos demostrado.
- La consulta a los 50 ms llega sin análisis en los tres casos fríos (5/5);
  a los dos segundos llega con análisis (5/5). Todos los trabajos terminan.
- **Priorizar desde `dj-transition` no supera la aceptación funcional:** el
  endpoint devuelve fallback al encontrar miss y el cliente solo refina una
  vez por pareja. Terminar antes después de esa respuesta no hace que se
  consuma el resultado. Chromium confirmó los casos listo antes/después en
  diez pruebas. La prueba caracteriza este comportamiento; no obliga a
  conservarlo si se define otro contrato de refinamiento.
- No se cambiaron colas, workers, descarte, análisis, transporte ni store.
  Reabrir esta candidata exige primero definir cómo consumir un resultado
  tardío antes del commit. No introducir reintentos indiscriminados.
- Validación de esta entrega: 70 ejecuciones aisladas del benchmark, 10 pruebas
  Chromium, 1.509 pruebas Python, typecheck y 1.123 pruebas del cliente; Ruff y
  `git diff --check` correctos.
- La matriz larga de carga, instrumentación de otros pools, biblioteca real,
  descargas/escaneo y medición completa cliente/servidor **sigue pendiente**.
  Se detuvo esa ampliación al fallar la puerta funcional del cambio candidato.

## Coordinación de catálogo completada (2026-09-22)

`syncCatalog(targetRevision?)` comparte una promesa por operación/generación,
agrupa revisiones pendientes y descarta resultados superados. La biblioteca
reconoce el éxito por generación y revisión, no por número de refresco. A → B → A
también invalida la consulta B aunque A ya estuviese reconocida. Las tres
peticiones terminan antes de una nueva ronda, incluso con error parcial.

- Misma revisión: 9 → 3 consultas en el escenario controlado; A → B → C: 9 → 6.
- Cuenta nueva empieza sin esperar respuestas antiguas; sus resultados y cleanup
  no afectan a la cuenta actual. No se abortan las peticiones antiguas.
- Errores conservan catálogo y permiten retry al siguiente refresco; sin
  revisiones se conserva el refresco conservador. No hay retry periódico.
- Invalidar conserva un catálogo ya disponible: también se usa al editar listas
  sin una consulta inmediata. La limpieza de cuenta sigue en sus llamadores.
- [Contrato, mediciones y reproducción](../performance/catalog-sync.md), con
  resultados JSONL. Tiempos virtuales/API simulada: no son ahorro de CPU ni red
  medidos sobre una instancia real.
- Typecheck y 1.138 pruebas frontend / 116 archivos; siete pruebas Chromium;
  `git diff --check`. Sin cambios Python ni validación física de audio.

## Guardado ODST por bloques completado (2026-09-22)

`ODSTDownloader.save_library()` usa `iter_json()` y escribe bloques de 128 pistas.
Conserva bytes, lock, podcasts del disco, permisos/inodo/symlinks y propagación de
fallos. Escribía in situ, sin fsync ni atomicidad (corregido después: ver
«Correcciones tras la revisión»); no se modificó la coordinación entre procesos
con Station.

- [Mediciones y reproducción](../performance/odst-save-streaming.md): cinco
  repeticiones, copia real de 208 pistas y corpus de 1k/10k/50k.
- Pico temporal completo a 50k: 245,14 → 229,11 MiB; a 208: 2,88 → 2,71 MiB.
  La lectura y reconstrucción del modelo completo sigue dominando memoria.
- No afirmar aceleración general: 50k 1,77 → 1,75 s, pero 10k 280 → 320 ms;
  copia real 9,44 → 9,85 ms. Bytes escritos iguales. No es RSS ni escucha.
- Validación: 1.521 pruebas Python, Ruff en archivos modificados y
  `git diff --check` correctos. Sin cambios frontend ni reinicio del motor.
- No se eliminaron la biblioteca residente ni la lectura completa para podcasts;
  no hay debounce nuevo. El archivo parcial tras un fallo quedó corregido después
  con la escritura atómica.

## Lectura ODST de podcasts sin reconstruir pistas completada (2026-09-22)

`read_podcast_fields()` sustituye la lectura/modelo completo durante el guardado:
lee por bloques con el decodificador estándar, valida y descarta cada pista y
conserva los dos campos de podcasts. Sigue recorriendo todos los bytes.

- [Mediciones, límites y reproducción](../performance/odst-podcast-read.md), con
  baseline `f5a5a8a`, cinco repeticiones alternadas y bytes finales idénticos.
- A 50k pistas: pico temporal Python 229,107 → 1,067 MiB; mediana del guardado
  completo 1.755 → 1.156 ms. No es RSS ni evidencia de escucha.
- Copia real de 208 pistas: 9,32 → 10,88 ms; 2,715 → 2,139 MiB. Se acepta ese
  coste pequeño por la mejora de escalabilidad; no afirmar aceleración universal.
- Compatibilidad diferencial: campos/tipos, claves duplicadas, Unicode, límites
  de bloque y corrupción. JSON malformado vacía podcasts como antes; errores de
  modelo/E/S mantienen los de memoria. Se corrigió esa distinción en el informe
  previo y su test, que no comprobaba explícitamente el valor esperado.
- Un descriptor conserva su lectura ante reemplazo POSIX. No hay bloqueo común
  ODST/Station ni protección contra carreras entre los dos escritores; la
  escritura parcial se corrigió después (ver la sección siguiente).
- Validación actual: **1.532 pruebas Python**, Ruff y `git diff --check` pasan;
  smoke del benchmark con el hash adicional del lector correcto. Sin cambios
  frontend, reinicio del motor, escritura de biblioteca real, push ni PR.
- Memoria del lector ligada al mayor valor individual y los podcasts; JSON
  malformado puede acumularse hasta EOF. La serialización conserva su lista de
  referencias. No afirmar memoria estrictamente constante.

## Correcciones tras la revisión (2026-09-22)

Un `/code-review` de `main...HEAD` dejó diez hallazgos sin verificar. Se
corrigieron los que podían perder datos o bloquear la interfaz y la proyección
de catálogo; los otros seis se analizaron y se descartaron (ver al final de esta
sección).

- `c9a40e8` Interfaz: las ediciones locales (metadatos, borrado, playlists)
  usaban el reinicio de cambio de cuenta, que borraba el refresco programado
  tras una descarga y abandonaba el sync en curso sin sustituto (`loading`
  podía quedarse activo). Ahora `beginLibraryEdit`/`endLibraryEdit`: se siguen
  descartando respuestas viejas sin esperar por ellas, pero el sync abandonado
  queda debido y se paga al terminar la edición, el temporizador sobrevive y una
  respuesta aplicada mientras la edición estaba en vuelo provoca otra lectura.
  `invalidateLibrarySync` queda solo para cambio de cuenta y hoy no tiene
  llamador en producción.
- ODST: `save_library()` escribe en un temporal con fsync y rename mediante
  `shared.atomic_file.replace_contents`, que sigue symlinks, conserva permisos,
  usa el umask por defecto en archivos nuevos y, si la carpeta no admite
  temporales, escribe in situ como antes. Cambian inodo y propietario (nada en
  Soundsible crea enlaces duros). Un fallo conserva el documento anterior.
  Coste: el fsync, ~50–75 ms por guardado (una vez por descarga) en disco
  giratorio; picos de memoria iguales.
  [Medición](../performance/odst-save-streaming.md#atomic-replacement).
- Espejo local: `save_library_file` abría el destino con `wb` antes de leer la
  fuente. Con el almacenamiento LOCAL apuntando a la carpeta de música (bucket
  `.`) y el manifiesto no escribible, espejo y fuente son `<music>/library.json`
  y quedaba vacío (reproducido en prueba). Ahora omite la copia si
  `os.path.samefile` y, si no, reemplaza con `replace_contents`, conservando
  symlink y permisos; cambia el inodo y gana fsync.
- Proyección de catálogo: un guardado solo reconstruye artistas/álbumes si
  cambian campos de catálogo u orden, así que un cambio en las reglas de
  `build_catalog_snapshot` no llegaba a bibliotecas existentes hasta la siguiente
  edición o descarga. Ahora `library_catalog.PROJECTION_VERSION` se guarda en
  `library_info`; al abrir la base con otra versión se reconstruye una vez, en
  orden de manifiesto (el álbum toma el primer año/género). Sustituye al
  backfill, cuya condición (canciones sin enlaces) se mantiene sin contar
  podcasts. Arranque normal ~1,2 ms; reconstrucción única ~115 ms a 1k y
  ~6,4 s / 151 MiB a 50k (tmpfs). Todas las bibliotecas actuales se reconstruyen
  una vez al actualizar, porque aún no tienen versión.
  [Detalle](../performance/incremental-library-writes.md).

Descartados tras revisar el código, porque el motor es **un solo proceso
gevent**: SQLite no cede el control, así que una transacción termina antes de
que corra otra petición. Reabrir si el motor pasa a varios procesos o hilos reales.

- Historial de deltas con `BEGIN IMMEDIATE` en cada conexión (0,1 s de espera):
  sin contención posible dentro del proceso; ~0,12 ms por llamada; si fallara,
  se envía la biblioteca completa.
- Conexión de sonoridad por petición (gevent convierte el thread-local en
  greenlet-local) que instala triggers y hace `INSERT OR IGNORE`: ~0,34 ms frente
  a 0,007 ms reutilizada; ningún otro proceso escribe esa base.
- `ConnectionPool.acquire` llama a la factory con el lock tomado y `release`
  necesita ese lock (en `main` no): como mucho 16 aperturas por base y proceso, y
  con gevent una espera de SQLite ya bloquea todo. Arreglarlo si se toca el pool.
- Variantes de carátula con lock, `flock` y SQLite en cada acierto: con gevent ya
  se servían en serie; el coste extra por acierto no se midió. Medir una
  cuadrícula real antes de tocarlo.
- Token de sonoridad que rota con reintentos y fallos: los clientes solo
  resincronizan con `loudness_updated`, como mucho cada 5 min y solo si hubo
  mediciones nuevas, y reciben deltas pequeños. Cambiarlo exigiría migrar
  triggers instalados.
- Ruta de delta heredada que devuelve un delta vacío en vez de 304 y no renueva
  `created`: solo se usa si falla el 304 temprano y la vía incremental; en el
  peor caso, una descarga completa al día.

## Pendientes de auditoría, sin declarar todo terminado

El índice de búsqueda local está hecho en `bc90a83` y la exportación por bloques
en `32929f7`. La candidata de prioridad DJ se evaluó y descartó como se explica
arriba. La coordinación de catálogo también está completada. Elegir el siguiente
chunk entre estos:

1. Presupuestos de admisión por recurso y colas: medir saturación primero;
   la prueba acotada de DJ no demuestra saturación global ni justifica prioridad
   desde el endpoint de refinamiento sin cambiar el contrato del consumidor;
   priorizar reproducción y siguientes pistas, descartar solo especulación
   obsoleta. No fusionar pools que están separados para evitar bloqueos.
2. Escrituras dirigidas: aunque las escrituras SQLite sean incrementales y la
   exportación ya no duplique memoria, snapshots, fingerprints y exports siguen
   recorriendo la biblioteca entera en cada guardado. El índice de búsqueda
   añade una pasada ordenada a las guardas que cambian campos de búsqueda u
   orden; controlar las mutaciones en memoria permitiría quitar esa pasada y la
   huella por consulta. Agrupar exports: ver la decisión de arriba. En ODST la
   serialización por bloques y la eliminación del segundo modelo están hechas;
   siguen pendientes evitar recorrer todos los bytes para conservar podcasts y
   la propiedad/coordinación de los dos escritores.
3. Línea base controlada de escucha y carga concurrente, cliente y servidor:
   cerrado/pausado/NORMAL/DJ/Live, frío/caliente, visible/oculto, sesiones largas,
   latencias, colas, CPU y memoria. Sigue pendiente; benchmarks sintéticos no la
   sustituyen. Validación iPhone/CarPlay requiere dispositivo físico.
4. Otros puntos exploratorios del informe (shell rebuild checks, clasificación
   de fallos de fondo) solo justifican cambios tras evidencia; no hacer limpieza
   global ni reescritura cosmética.

## Última validación y cómo retomar

Validación histórica del chunk de exportación `32929f7` (la del lector ODST
está en su sección anterior):

- Suite Python completa: **1.509 passed**.
- `tests/test_library_export.py`: **35 passed**; con los tests de biblioteca
  canónica, escaneo de carpetas y multiusuario, 100.
- `scripts/benchmark_library_export.py` (200/1k/10k/50k y la biblioteca real en
  solo lectura, 5 repeticiones) exige que las tres copias igualen `to_json()`.
- `cd ui_web && npm test`: typecheck y **1.123 tests / 115 files** pasan.
- Ruff y `git diff --check` pasan en archivos modificados.
- Linux validado; Windows nativo y escucha física siguen pendientes. El motor
  real (puerto 5005) no se reinició ni se probó con el índice de búsqueda ni con
  la nueva exportación; lo hará en su próximo arranque.

Antes de editar, ejecutar `git status --short`, comprobar rama y leer `AGENTS.md`.
Los resultados anteriores son evidencia histórica, no sustituyen pruebas del
próximo cambio. Comandos habituales:

```sh
venv/bin/python -m pytest -q
venv/bin/ruff check <archivos_python_modificados>
git diff --check
cd ui_web && npm test
```

Este traspaso no requiere herramientas de memoria privadas ni acceso al chat.
El usuario puede iniciar otra sesión con:

> Continúa en la rama fix/sqlite-connection-lifecycle. Lee AGENTS.md y
> docs/audits/ENGINEERING_HANDOFF.md. Propón el siguiente chunk de la lista de
> pendientes y planéalo antes de implementar.
> No abras PR ni hagas push; cada implementación terminada debe quedar commiteada.
