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

## Migración y compatibilidad

La primera apertura incorpora los archivos, las canciones guardadas del antiguo
`favourites.json` y las referencias de playlists. Los IDs ya utilizados por los
archivos se conservan como valores iniciales de identidad interna; dejan de
seguir al hash desde ese momento. Las nuevas incorporaciones online reciben un
ID opaco. Orden, repeticiones, fechas, marcas y selección de carátula se conservan.

El JSON antiguo queda como restauración, sin volver a leerse después de completar
la migración. Los endpoints antiguos de guardados/favoritos son fachadas sobre
SQLite. Los nombres técnicos antiguos sólo se interpretan en las fronteras de
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
