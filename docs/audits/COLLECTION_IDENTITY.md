# Identidad de colección y fuentes reproducibles

## Contrato

Un elemento musical de una cuenta tiene `item_id` estable. Un archivo tiene
`id` y `file_hash`; un vídeo tiene su ID de proveedor. Descargar, reparar o
retirar un archivo cambia las fuentes del elemento, nunca su identidad ni sus
pertenencias a playlists. Una aparición en una cola conserva además su propio
`queueId` y la fuente de audio preparada para esa aparición.

La colección canónica vive en `users/<cuenta>/library.db`: `collection_items`
guarda el elemento y sus propiedades personales, `collection_keys` sus
identificadores externos, `collection_sources` las fuentes online y
`collection_files` las asociaciones explícitas con el catálogo de archivos.
`collection_user_state` conserva valoraciones y reproducciones aunque se retire
la fuente; `track_user_state` es su proyección para consultas antiguas.
`playlist_tracks.track_id` conserva el nombre histórico en SQLite, pero su valor
es la referencia al elemento, no la dirección del audio.

Los identificadores de proveedor no son únicos: no se fusionan automáticamente
dos archivos/ediciones por compartir vídeo o ISRC. La incorporación resuelve
evidencia exacta y no ambigua, o crea un elemento. La identidad interna de una
cuenta nunca se copia desde el catálogo compartido del pool.

`GET /api/library/collection` materializa elementos, fuentes seleccionadas,
favoritos y playlists desde una misma transacción de lectura. El cliente puede
seguir usando el catálogo de archivos para edición, bytes y descargas, pero no
reconstruye la colección emparejando archivos y favoritos. Las referencias de
colección se indexan por `item_id`; el audio usa su descriptor de fuente.

Añadir desde búsqueda/DJ envía un descriptor musical a la operación de playlist.
Admisión, guardado y pertenencia se confirman en una sola transacción. No hay una
segunda petición de guardado que pueda fallar después de añadir la referencia.

El motor anuncia la capacidad con la cabecera `X-Soundsible-Collection`; no la
inyecta en ajustes del usuario. El snapshot devuelve un ETag por cuenta y
revisiones de colección/biblioteca/artwork/loudness; las recargas sin cambios
responden 304 antes de materializarlo. Una vez negociado, la web actualiza un
solo recurso. El catálogo añade referencias privadas después de sus cachés de
proveedor; nunca almacena `item_id` de una cuenta en ellas.

Android conserva `item_id` en programa, planes, resolución de catálogo y
metadatos offline; las URI y IDs de ocurrencia siguen fijando el audio. iOS y
coche reciben `id` estable y `track_id` de fuente por separado. La copia offline
retiene la asociación persistida aunque el servidor seleccione otro archivo.
Las filas repetidas de playlist se seleccionan por posición, no por canción.

## Migración y compatibilidad

La primera apertura incorpora los archivos, las canciones guardadas del antiguo
`favourites.json` y las referencias de playlists. Los IDs ya utilizados por los
archivos se conservan como valores iniciales de identidad interna; dejan de
seguir al hash desde ese momento. Las nuevas incorporaciones online reciben un
ID opaco. Orden, repeticiones, fechas, marcas y selección de carátula se conservan.

El JSON antiguo queda como restauración, sin volver a leerse después de completar
la migración. Los endpoints antiguos de guardados/favoritos son fachadas sobre
SQLite. La copia completa y restaurable de la colección es `library.db`
(incluida por `shared.instance_backup`); `library.json` sigue siendo el manifiesto
portable de archivos y referencias, no un backup de elementos online y marcas.
Los nombres técnicos antiguos sólo se interpretan en las fronteras de
compatibilidad y en la incorporación, no en cada lectura de una playlist.

Una referencia histórica sin suficiente evidencia permanece visible como elemento
sin fuente disponible. La falta de audio no elimina un elemento ni su posición.
La migración debe fallar y revertir ante datos ilegibles; no sustituirlos por una
colección vacía.

## Plan y aceptación

1. Sustituir la normalización vídeo → hash por entidades y relaciones persistidas.
2. Migrar guardados y playlists; unificar sus escrituras y rechazar conflictos.
3. Adaptar biblioteca web, Android, búsqueda/DJ, carátulas y edición de playlists.
4. Conservar fuentes fijadas en reproducción, análisis por audio y copias offline.
5. Validar migración/reinicio, incorporación antes/después de descarga, reparación,
   retirada de fuente, ambigüedad, aislamiento de cuentas y escritores concurrentes.
6. Ejecutar Python, UI, cuatro perfiles de navegador y comprobaciones nativas;
   incorporar el `main` remoto vigente antes de dejar lista la única PR.


## Decisión y alcance de la PR #423

La separación original tenía sentido para las fuentes: el hash identifica bytes
y permite compartir audio/análisis; el ID de YouTube identifica un recurso
remoto. El fallo fue utilizarlos además como identidad musical de la cuenta y
reconstruir esa identidad en cada consumidor. La colección persistida elimina
esa doble responsabilidad. No se alteran medidas, ordenación ni curvas del DJ:
siguen dependiendo del audio analizado, no de la identidad de colección.

Las pruebas cubren migración y reapertura, referencias duplicadas y carátula,
incorporación y pertenencia atómicas con rollback, dos escritores, retirada y
reparación de fuentes, estado personal durable, ambigüedad, cachés por cuenta,
ETag/304, playlists del coche y copias offline. El ensayo de datos del incidente
usa una copia SQLite consistente; no aplica la migración al servicio activo.
La evidencia de ejecución y sus límites se registra en la PR, no equivale a
aceptación física ni despliegue.
