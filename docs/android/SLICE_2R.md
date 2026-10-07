# S2r: primer vertical de metadatos y carátulas

Primer recorrido implementado y validado con audio WAV. No cierra todavía la
paridad de edición: los formatos con tags pueden cambiar de ID al reescribir el
archivo. Ese caso requiere un contrato de edición que preserve fuente/identidad
y aceptación propia antes de considerar esta fila completa.

Reutilizar formulario/estilos/textos de MetadataEditor mediante una presentación
sin imports de stores/audio web. Web conserva su adaptador; Android aporta handlers
REST nativos y scope capturado. Editar title/artist/album/album_artist por POST
`/api/library/tracks/<id>/metadata`; confirmar status y snapshot tras refresh.
El motor admite fallback metadata-only: mostrar biblioteca confirmada, sin afirmar
que el archivo se reescribió si respondió fallback.

Carátulas: upload FormData file por POST `/api/library/tracks/<id>/cover` y POST
`/api/library/tracks/<id>/cover/none` para quitar. Respuestas reales, refresh/revisión de artwork, error visible
sin cerrar y cancelación/cierre del editor al cambiar cuenta. No aceptar URLs de
proveedor introducidas por el cliente ni una URL de audio. Separar prueba de
multipart APK de aceptación del selector OS: File sintético no prueba Photo Picker.

El programa debe recibir cambios confirmados de metadata sin reconstruir fuentes,
perder posición/pausa o cambiar keys/tokens. Usar MediaItem existente con metadata
nueva, preservando localConfiguration/extras y límites; no aceptar nueva URI desde
UI. Media3 permite intentar continuación al reemplazar un item compatible sólo
con metadata diferente; verificar comportamiento con la versión instalada, no
convertir esa posibilidad documental en garantía:
[Player.replaceMediaItem](https://developer.android.com/reference/androidx/media3/common/Player#replaceMediaItem(int,androidx.media3.common.MediaItem)).

Aceptación: HTTP/HTTPS, texto/cover confirmados y carátula privada revisada,
metadata actual y repeticiones en cola, posición/pausa/ocurrencias conservadas,
fallo recuperable, scope/account y editor cerrado. No invalidar copias offline
válidas por un cambio de texto; revisar su metadata local y políticas de cover
separadamente. Guardar evidencia por capa y pendientes. Las otras acciones de
biblioteca, DJ/Live/Auto y firma/actualización mantienen sus gates.


## Evidencia local

Typecheck/Vitest: **1.405 tests / 160 archivos**, incluidos tres de presentación
(error/retry, confirmación y cierre por cuenta). Python: **49 tests** de metadata
y artwork. Ruff/diff correctos. APK HTTP/HTTPS verificado: **dos tests pasan**,
edición real, multipart/bitmap verde servido por motor, retirada de cover, dos
ocurrencias y labels de copia ready conservando bytes/pausa/posición/keys/token.
El selector de archivo se simula con File: no prueba el selector OS.

El motor corregía WAV sin tags como éxito sin guardar cambios ni vincular artwork;
ahora conserva metadata canonical y sidecar sin alterar audio. Null album_artist
en fallback limpia el valor explícitamente. Media3 mantiene localConfiguration al
reemplazar sólo metadata y revision de artwork; extras permiten esperar IPC nuevo.
Las copias existentes actualizan labels en SQLite sin volver a descargarlas.

Los primeros fallos pertenecían al fixture: ArtworkStore.path devuelve str y el
selector del título encontraba el input file oculto. Corregidos manteniendo las
assertions. Última suite APK completa es S2q (31 + dos fases offline); últimas
browser completas son S2j. Repetir sobre HEAD final antes del PR. Sin CI, proveedor
vivo, selector OS ni aceptación física. Instrumentación dirty/HEAD previo,
artifact de desarrollo. [Evidencia](evidence/s2r.json).

Continuación: edición sin rehash para preservar fuente e identidad en todos los
formatos, validación de selector/cancelación y resto de biblioteca; después la
matriz completa DJ/Live/Auto y firma/actualización. No habilitar alpha parcial.
