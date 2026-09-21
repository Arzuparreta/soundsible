# Traspaso de la optimización de recursos de Soundsible

Punto de entrada para continuar con otro agente sin el historial del chat.
Estado verificado al preparar este documento: rama `fix/sqlite-connection-lifecycle`,
último chunk funcional `c544318`. Este traspaso se incorpora en un commit posterior.

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

Documentación y resultados reproducibles:

- [Selección local](../performance/local-catalog-selection.md),
  [revisiones](../performance/library-revisions.md),
  [deltas iniciales](../performance/library-deltas.md).
- [Escrituras incrementales](../performance/incremental-library-writes.md),
  [serialización acotada](../performance/library-delta-serialization.md),
  [deltas por journals](../performance/journal-library-deltas.md).
- [Coordinación Memo](../performance/memo-coordination.md),
  [cuota de artwork](../performance/artwork-variant-quota.md).
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

### Artwork: último chunk

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

## Próximo chunk acordado como dirección: índice de búsqueda local

El usuario preguntó qué seguía y se propuso **índice de búsqueda local en SQLite**.
Todavía no se ha diseñado en detalle ni implementado. No hay permiso implícito
para introducir una búsqueda con resultados distintos. La siguiente acción es
explorar, concretar un plan y continuar según la petición del usuario.

Puntos de entrada:

- `shared/api/routes/catalog.py`: `_local_catalog()` y sus helpers de normalización,
  puntuación, entidades y desempates.
- `tests/fixtures/local_catalog_reference.py`: selector de referencia congelado.
- `scripts/benchmark_local_catalog.py` y pruebas de catálogo/selección actuales.
- `shared/database.py` ya tiene FTS y proyecciones; examinar cobertura real antes
  de inventar otro índice. Verificar qué modelo consume `_local_catalog()` y cómo
  refleja modificaciones aún sin guardar.

Resultado deseado: candidatos indexados antes del ranker actual; índice en disco,
actualización incremental al guardar, sin segunda biblioteca residente en RAM.
Conservar resultados **y orden**: acentos, substring, palabras reordenadas,
artistas/álbumes, campos vacíos, IDs duplicados, empates y orden de biblioteca.
FTS por tokens no garantiza substring: demostrar que los candidatos son un
superconjunto de todas las coincidencias del ranker o usar fallback equivalente.

Validación mínima del futuro plan: equivalencia exacta con referencia, ediciones,
altas/bajas, rekeys, reinicio, consultas simultáneas e índice ausente/desactualizado;
benchmark 1k/10k/50k, consultas densas/raras/ausentes, memoria, tamaño en disco y
sobrecoste de actualización. No prometer latencia de audio sin medirla.

## Pendientes de auditoría, sin declarar todo terminado

1. Índice/candidatos de búsqueda local: siguiente dirección indicada arriba.
2. Presupuestos de admisión por recurso y colas: medir saturación primero;
   priorizar reproducción y siguientes pistas, descartar solo especulación
   obsoleta. No fusionar pools que están separados para evitar bloqueos.
3. `syncCatalog()` todavía usa `inFlight` booleano y retorno inmediato; revisar
   contrato de promesa compartida, generación/cuenta y retry. `syncLibrary()`
   **ya comparte una promesa**; no rehacer ese arreglo.
4. Escrituras dirigidas y exportación portable: aunque las escrituras SQLite sean
   incrementales, snapshots, fingerprints y exports siguen teniendo recorridos
   completos. Agrupar exports requiere decidir explícitamente su durabilidad.
5. Línea base controlada de escucha y carga concurrente, cliente y servidor:
   cerrado/pausado/NORMAL/DJ/Live, frío/caliente, visible/oculto, sesiones largas,
   latencias, colas, CPU y memoria. Sigue pendiente; benchmarks sintéticos no la
   sustituyen. Validación iPhone/CarPlay requiere dispositivo físico.
6. Otros puntos exploratorios del informe (shell rebuild checks, clasificación
   de fallos de fondo) solo justifican cambios tras evidencia; no hacer limpieza
   global ni reescritura cosmética.

## Última validación y cómo retomar

Último chunk funcional `c544318`:

- Suite Python completa: **1.429 passed**.
- Suite específica final de cuota: **25 passed**, incluye tres casos añadidos
  tras la suite completa (fallo de índice, publicación interrumpida, paths).
- `cd ui_web && npm test`: typecheck y **1.123 tests / 115 files** pasan.
- Ruff y `git diff --check` pasan en archivos modificados.
- Linux validado; Windows nativo y escucha física siguen pendientes.

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
> docs/audits/ENGINEERING_HANDOFF.md. Revisa la auditoría original y planea el
> índice de búsqueda local en SQLite conservando exactamente sus resultados.
> No abras PR ni hagas push; cada implementación terminada debe quedar commiteada.
