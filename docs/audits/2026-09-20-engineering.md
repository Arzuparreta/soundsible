# Revisión de ingeniería y consumo de recursos

Fecha: 2026-09-20. Código revisado: `a77181f`, `main` local, árbol inicialmente
limpio. No se ha usado código de PR abiertas. No se ha contrastado esta revisión
con posibles commits posteriores de GitHub. Este documento y su reproductor son
el entregable: las optimizaciones propuestas aún no están implementadas.

La oportunidad principal está en **hacer menos trabajo por operación y cerrar
correctamente el ciclo de vida de los recursos**. Hay fallos reproducibles y
costes evitables; no hay evidencia para prometer una reducción global de CPU o
memoria concreta. Reformatear archivos o cambiar de framework no resolvería las
causas encontradas.

## Evidencia y alcance

Se han revisado lectura/escritura de biblioteca, SQLite, búsqueda, descubrimiento,
trabajos de fondo, prefetch, cachés, artwork, diagnóstico, arranque web, transporte
de audio y organización del estado. La revisión de desktop, iOS, Live, proveedores
y empaquetado es parcial: no equivale a una auditoría exhaustiva de cada plataforma.

| Comprobación | Resultado | Qué demuestra y qué no |
| --- | --- | --- |
| Servidor existente, muestra pasiva de 30 s | CPU media por muestra 0,033% de un núcleo; PSS estable 354,63 MiB; sin lecturas/escrituras físicas contabilizadas | Describe ese intervalo sin cliente local visible; no es una prueba controlada de reposo ni de reproducción |
| `/api/health` en el servidor existente | Pool: 14 creadas, 0 libres, máximo 16 | Señal para investigar; una instantánea no demuestra por sí sola una fuga ni su origen |
| SQLite temporal, 16 trabajadores secuenciales sin scope | Pool llega a 16/16 sin libres; un trabajador recibe `TimeoutError` | Defecto reproducible de devolución; no depende de la biblioteca real |
| Factory del pool falla dos veces, capacidad 2 | `created=2`, `idle=0`, aunque no se creó ninguna conexión | Pérdida reproducible de capacidad ante un error de apertura |
| Serialización sintética, mediana de 3 repeticiones | Ver tabla siguiente | Coste de conversión; excluye SQL, anotaciones, HTTP y navegador |
| Análisis DJ sintético de 90 s, mismo HEAD en ambos procesos | 27–36 ms de pared; pico RSS 64–65 MiB; resultados equivalentes | Una ejecución por proceso, solo extracción de características; no es una mejora antes/después ni incluye decodificación |
| Validación existente | 44 pruebas Python dirigidas; 1.073 pruebas frontend en 113 archivos; typecheck y Ruff correctos | La base pasa estos controles pese a los defectos reproducidos; no acredita dispositivos físicos |

El proceso del servidor ya estaba iniciado: no se verificó su revisión cargada,
por lo que sus métricas no deben atribuirse automáticamente al HEAD del checkout.
Había otras aplicaciones, incluido un juego. La presión de I/O del sistema fue
alta durante la muestra, pero no hubo I/O físico atribuido al árbol del servidor:
no se debe imputar esa presión a Soundsible.

| Pistas sintéticas | Conversión actual, mediana | JSON compacto sin comprimir |
| --- | ---: | ---: |
| 1.000 | 15,60 ms | 712.821 bytes |
| 10.000 | 164,55 ms | 7.156.821 bytes |
| 50.000 | 856,18 ms | 35.916.821 bytes |

La medición reproduce `to_json → json.loads → json.dumps`, con pistas simples.
No es latencia del endpoint ni tamaño transferido con compresión. El script
adjunto permite repetirla; sus tiempos variarán con el equipo y la carga.

## Hallazgos prioritarios

### 1. Devolución incompleta de conexiones fuera de peticiones — prioridad alta

**Confirmado por reproducción.** En [database.py](../../shared/database.py),
`_get_connection()` toma una conexión y `_release_at_request_end()` registra su
devolución. [request_scope.py](../../shared/request_scope.py) no registra nada si
no hay scope. Terminar el trabajador no devuelve el slot al pool. Además,
`ConnectionPool.acquire()` incrementa `_created` antes de llamar a la factory y
no lo corrige cuando esta falla.

Hay scope explícito en el commit diferido del orquestador, pero no en su
`_wrap_task()` general. También hay pools independientes y pools por búsqueda.
Con gevent parcheado, «thread» no debe interpretarse automáticamente como un
hilo nativo persistente. Deben inventariarse los puntos de entrada, incluidos
workers, timers, sockets y comandos, y reproducirlos con el orden de imports real.

**Cambio:** propiedad explícita de la conexión por unidad de trabajo; devolución
en `finally`, incluidas excepciones y cancelación; rollback del contador si falla
la factory. Revisar scopes anidados y recursos liberados antes del streaming.
No basta con aumentar el máximo del pool.

**Aceptación:** centenares de trabajos efímeros no consumen slots acumulativos;
un error de apertura no reduce la capacidad; peticiones y trabajos simultáneos
no comparten una conexión prestada; streaming no retiene conexiones innecesarias.
Riesgo medio por concurrencia y transacciones. Primera intervención recomendada.

### 2. Refresco completo de biblioteca y conversiones redundantes — prioridad alta

**Confirmado en código y medido parcialmente.**
[get_library](../../shared/api/routes/library.py) convierte el modelo a JSON
indentado, lo vuelve a parsear, añade anotaciones y lo serializa otra vez.
[models.py](../../shared/models.py) usa `asdict` para cada pista.
[stores/library.ts](../../ui_web/src/stores/library.ts) sustituye toda la biblioteca
y vuelve a solicitar catálogo; el debounce de 1,5 s agrupa ráfagas, pero no evita
refrescos completos en una descarga larga con terminaciones espaciadas.

**Cambio en dos pasos:** primero un payload público estructurado que omita
exactamente los mismos campos locales y conserve el contrato, sin viaje JSON
intermedio. Después revisiones/ETag y deltas de pistas, bajas y playlists, con
fallback a snapshot completo tras huecos de revisión o reconexión. Las revisiones
de artwork, loudness y guardados también deben invalidar sus datos: usar solo la
revisión de biblioteca produciría información obsoleta.

**Aceptación:** equivalencia de payload, aislamiento de cuentas y ediciones;
descargar un álbum no retransmite N bibliotecas; medir bytes, CPU, memoria temporal
y reconstrucción de índices. Primer paso de riesgo bajo; deltas de riesgo medio.

### 3. Mutaciones pequeñas con escritura de snapshot completo — prioridad alta

**Confirmado en código.** `LibraryManager._save_metadata()` llama a
`DatabaseManager.replace_library()` y exporta JSON. Esa ruta elimina las pistas
ausentes, hace upsert de todas las entrantes y reconstruye proyecciones; el coste
crece con la biblioteca incluso cuando la
operación inicial es pequeña. No todas las mutaciones usan esta ruta: hay que
medir cada llamador, no afirmar que toda escritura es completa.

**Cambio:** operaciones transaccionales específicas para metadata, altas/bajas y
playlists; mantener revisión optimista, aliases, fecha de incorporación, estado
del usuario e invariantes de catálogo. Exportación portable agrupada con una
política explícita de durabilidad. Reservar reemplazo completo para importación,
reparación o migración.

**Aceptación:** filas afectadas y bytes WAL por edición dejan de crecer con todas
las pistas; pruebas de escrituras concurrentes, rekey y recuperación tras fallo.
Riesgo alto: descomponer después de estabilizar el pool y medir las rutas.

### 4. Búsqueda local escanea y ordena antes de limitar — prioridad alta a escala

**Confirmado en código; latencia pendiente de medir.** `_local_catalog()` en
[catalog.py](../../shared/api/routes/catalog.py) puntúa título, artista y álbum de
todas las pistas y ordena las coincidencias antes de aplicar el presupuesto de
salida. Limitar la respuesta no limita el trabajo. El pool de proveedores se crea
por búsqueda; distintas consultas simultáneas multiplican el trabajo.

**Cambio:** precalcular normalización por revisión; selección top-k donde conserve
desempates; evaluar generación de candidatos indexada y aplicar el ranker actual
después. FTS por sí solo no garantiza la semántica actual de substring, acentos y
artista/álbum: necesita comparación de resultados, no solo un benchmark rápido.

**Aceptación:** corpus de consultas reales y casos ambiguos mantiene resultados y
orden; comparar 1k/10k/50k pistas, consultas frías/calientes y concurrentes; medir
p95 y retraso del event loop mientras se reproduce audio. Riesgo medio.

### 5. Presupuestos de concurrencia fragmentados — prioridad alta bajo carga

**Confirmado estructuralmente; saturación no medida.** Hay pools separados para
orquestación, búsqueda, resolución, graph, discovery, DJ, lyrics y migración.
`max_workers` limita ejecución, pero no garantiza cola acotada. `request_analysis`
deduplica por identidad sin límite global de identidades pendientes. Lyrics ya
ofrece un ejemplo de admisión con semáforo.

**Cambio:** presupuestos de admisión por recurso (CPU, disco, proveedor), prioridad
para reproducción inmediata y siguientes pistas, deduplicación y descarte solo
de trabajo especulativo obsoleto. No fusionar todo en una única cola: el graph
está separado precisamente para no quedar detrás de resolución lenta. Mantener
cuotas reservadas y una política de espera/reintento para trabajo solicitado.

**Aceptación:** audio y control remoto siguen respondiendo durante descargas,
escaneo y DJ frío; medir profundidad, edad y cancelaciones de cada cola, p95 de
API y lag del hub. Comprobar qué trabajo realmente sale del hub gevent.
Riesgo medio-alto; no recortar análisis ni descubrimiento para abaratarlo.

### 6. Estado de prefetch sin presupuesto de retención — prioridad media

**Confirmado en código.** [prefetch.ts](../../ui_web/src/lib/prefetch.ts) conserva
`lastWarm`, `lastDownloadAttempt` y `preparation` por ID sin eviction. El TTL decide
cuándo reintentar, no elimina entradas. La observación consulta los primeros ocho
IDs; tareas que no lleguen a terminal pueden retrasar las posteriores.

**Cambio:** retención acotada de resultados terminales, propiedad/cancelación de
suscripciones, observación justa y revalidación del estado `ready` si el servidor
reinicia o elimina el archivo. No desalojar trabajo activo ni romper la garantía
de que la siguiente pista esté preparada.

**Aceptación:** miles de IDs y navegación prolongada estabilizan heap, listeners
y peticiones; desconexión/reconexión y fallos parciales conservan recuperación.
El crecimiento existe; su peso relativo en memoria aún no está medido.

### 7. Diagnósticos hacen trabajo proporcional al backlog — prioridad media

**Confirmado en código; impacto durante escucha pendiente.** La captura automática
usa un ring acotado, persiste y vacía periódicamente.
[PlaybackTraceOutbox.pending](../../ui_web/src/lib/playbackTraceOutbox.ts) usa
`getAll`, filtra por cuenta, ordena y serializa el conjunto para calcular tamaño
antes de recortarlo. El límite se aplica al leer; no hay el mismo control de
admisión en el `put` persistente. El flush llama a `pending()` antes de comprobar
el backoff de red. La promesa de persistencia también puede acumular trabajo si
el almacenamiento es lento.

**Cambio:** cursores/índices por cuenta y fecha, tamaño contabilizado al escribir,
poda incremental y lectura del lote necesario. Separar mantenimiento acotado de
envío. Conservar ACK, deduplicación, aislamiento y capacidad de diagnosticar las
interrupciones de iOS; desactivar trazas perdería una capacidad valiosa.

**Aceptación:** 24 h offline simuladas, varias cuentas y disco lento no exigen
cargar toda la outbox por ciclo; límites verificables y huecos reportados.

### 8. Artwork: lectura global y variantes sin cuota total — prioridad media

**Confirmado en código.** `ArtworkStore.annotate()` lee todas las referencias de
la instancia aunque se soliciten pocas pistas. `variant()` acota tamaños y
concurrencia, pero no hay cuota total de disco/eviction de variantes en ese módulo.
«Número finito de tamaños por imagen» no limita el número de imágenes.

**Cambio:** consulta por IDs en lotes, cuota/LRU de derivados reconstruibles,
métricas de originales y variantes por separado. Los originales y referencias
son datos persistentes: no tratarlos como caché descartable.

**Aceptación:** anotar 20 pistas no materializa todas las referencias; regenerar
una variante eliminada mantiene el aspecto y las revisiones. Riesgo bajo-medio.

## Arquitectura, código y mantenimiento

El estado central tiene 5.128 líneas, audio 2.079, `shared.api` 2.099 y la capa de
base de datos 3.008. La longitud no demuestra lentitud. Sí concentra transiciones,
efectos y conocimiento cruzado, lo que dificulta cambiar políticas sin romper
reproducción o recuperación.

La separación útil sería por propiedad y ciclo de vida: sesión/cola, coordinador
DJ, transporte, sincronización remota y persistencia; servicios de biblioteca,
búsqueda y trabajos inyectados en las rutas. Cada pieza debe tener entradas,
salidas, cancelación y propietario explícitos. Evitar trasladar funciones a otros
archivos manteniendo el mismo estado global y llamarlo una mejora arquitectónica.

Puntos adicionales concretos:

- `syncLibrary()` y `syncCatalog()` devuelven inmediatamente al encontrar una
  operación en vuelo, aunque sus llamadores pueden interpretar el `await` como
  sincronización terminada. Compartir una promesa con contrato explícito de
  frescura y generación; probar cambio de cuenta y llamadas simultáneas.
- `Memo.resolve()` comprueba la caché antes de adquirir el lock de flights. Un
  llamador que vio miss puede quedar retrasado hasta que otro complete y retire
  su flight, y entonces iniciar otra computación. Revalidar bajo coordinación;
  añadir una prueba determinista de esa ventana. Hallazgo de inspección, no
  reproducido en esta pasada.
- `ensure_ui_dist()` recorre fuentes y stats al servir el shell y reconstruye
  bajo lock si hace falta. Es coste de arranque/recarga, no del bucle de audio.
  Medir primero; si importa, invalidación observada/huella que conserve la
  actualización automática, incluyendo fuentes públicas y archivos eliminados.
- Los `except: pass` o equivalentes en trabajo de fondo necesitan clasificación:
  fallback esperado, cancelación o error operativo con contador. No sustituirlos
  todos por logs ruidosos ni ocultar fallos de análisis indefinidamente.
- Ruff pasa; no se ha demostrado una masa de código muerto eliminable. F401/F841
  no detectan todo el código inaccesible, y `max-complexity` configurado no activa
  por sí mismo C901 con la selección actual. Una limpieza posterior debe apoyarse
  en referencias de Python/TS, rutas, imports dinámicos, builds y consumidores.
- El tamaño de `ui_web/dist` existente es 2,2 MiB con 103 archivos en assets.
  No es el JS inicial transferido ni prueba de un bundle vigente. Medir waterfall
  y chunks realmente cargados antes de culpar a dependencias o fuentes.

Conservar las mejoras ya presentes: virtualización y filas variables, rutas lazy,
selectores de identidad memoizados, agrupación de eventos, cachés de previews,
single-flight, límites de análisis DJ y protecciones de visibilidad. La ruta
`ProgramOutput` distingue iOS de carrier en otros dispositivos por razones de
compatibilidad; cambiarla exige aceptación acústica, no solo menor CPU sintética.

## Secuencia de trabajo y criterios de decisión

| Entrega | Contenido | Evidencia exigida |
| --- | --- | --- |
| A | Ciclo de vida del pool y fallo de factory | Reproductores convertidos en regresiones; HTTP, sockets, workers y gevent |
| B | Payload directo, anotación de artwork por IDs | Equivalencia de contrato; CPU/bytes/memoria a escala |
| C | Retención de prefetch y outbox incremental | Sesiones largas/offline; heap y trabajo pendientes estabilizados |
| D | Revisión/deltas e índices de búsqueda | Menos tráfico y CPU sin cambios en resultados, identidad ni orden |
| E | Escrituras incrementales y presupuestos de trabajo | Menor WAL/I/O; latencia de audio/control estable bajo carga |
| Transversal | Extraer límites de módulos al tocar cada dominio | Mismos contratos; menos dependencias y efectos compartidos |

No hay motivo para una reescritura global con la evidencia disponible. Cada
entrega debe poder revisarse y revertirse por separado, con un PR y su etiqueta
de impacto; las correcciones funcionales normalmente serán `impact:patch`.

Falta una **línea base controlada del cliente** para responder cuánto consumo
puede ahorrarse realmente durante la escucha. Protocolo de aceptación:

1. Fijar revisión de servidor y bundle, navegador, hardware, biblioteca, canción,
   red, volumen y viewport. Medir servidor y árbol del cliente por separado.
2. Tres repeticiones tras calentamiento: cliente cerrado, abierto pausado,
   NORMAL local, NORMAL preview frío/caliente, DJ frío/caliente, Live. Repetir
   visible y oculto; separar arranque de régimen estable.
3. Registrar CPU integrada, PSS/heap, tareas largas, lag del hub, latencia p50/p95,
   bytes de red y disco, tamaños de colas y número de conexiones. GPU/energía del
   equipo no deben presentarse como consumo exclusivo del navegador.
4. Añadir búsqueda/descarga concurrente y un recorrido de horas para crecimiento.
   Para cambios de audio: saltos, seek, pause/resume, fin de pista, mezclas,
   reconexión, bloqueo y PWA Safari con CarPlay por cable en dispositivo real.
5. Exigir equivalencia funcional y reducción repetible de la métrica objetivo.
   Definir presupuestos numéricos tras la línea base; no inventar un porcentaje
   de ahorro ni aceptar una mejora de CPU que empeore tiempo hasta audio.

## Reproducción

Desde la raíz del repositorio:

```sh
venv/bin/python docs/audits/reproduce_resource_review.py
venv/bin/python scripts/benchmark_dj_analysis.py --reference HEAD --seconds 90 --repeats 1 --output /tmp/soundsible-audit-dj.json
venv/bin/python -m pytest -q tests/test_connection_pool.py tests/test_request_db_budget.py tests/test_api_memo.py tests/test_dj_spectral_memory.py tests/test_discovery_feed_budget.py tests/test_artwork.py
venv/bin/ruff check .
```

Frontend: `npm test` desde `ui_web`. Muestreo pasivo:
`python scripts/resource_sample.py --group server=PID --seconds 30 --output /tmp/resources.json`,
sustituyendo PID por el proceso actual. El reproductor sintético solo crea una
base temporal y acorta su timeout de agotamiento; no modifica datos de usuario.

La revisión previa de rendimiento orientó la separación cliente/servidor, pero
sus porcentajes históricos no se han reutilizado como resultados actuales.
