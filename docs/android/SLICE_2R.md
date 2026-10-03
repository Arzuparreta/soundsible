# S2r: metadatos y carátulas, siguiente vertical de biblioteca

Contrato pendiente. No es una capacidad implementada ni validada.

Reutilizar formulario/estilos/textos de MetadataEditor mediante una presentación
sin imports de stores/audio web. Web conserva su adaptador; Android aporta handlers
REST nativos y scope capturado. Editar title/artist/album/album_artist por POST
`/api/library/tracks/<id>/metadata`; confirmar status y snapshot tras refresh.
El motor admite fallback metadata-only: mostrar biblioteca confirmada, sin afirmar
que el archivo se reescribió si respondió fallback.

Carátulas: upload FormData file por POST `/api/library/tracks/<id>/cover` y DELETE
misma ruta para quitar. Respuestas reales, refresh/revisión de artwork, error visible
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
