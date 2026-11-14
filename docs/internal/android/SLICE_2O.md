# S2o: gestión de playlists con condiciones de escritura

Menús de tres puntos de listas y colecciones ofrecen renombrar, duplicar,
eliminar, ordenar y elegir carátula adquirida. Las filas ofrecen mover y quitar
una ocurrencia: filtrar una lista con IDs repetidos conserva el índice original.
No se elimina el archivo al quitar pertenencia ni al borrar la playlist.

Las nuevas rutas `/api/library/playlist-edits` exigen el orden o pertenencia
capturados. Un cambio concurrente devuelve 409 sin sobrescribirlo; un motor
antiguo rechaza la ruta sin aplicar una escritura incondicional. La UI confirma
respuesta real, refresca y mantiene errores visibles. Prompts, confirmaciones y
carátulas se cierran al cambiar cuenta. Duplicar confirma primero creación y luego
contenido; si falla el segundo paso puede quedar una lista vacía recuperable.

El orden se persiste en `settings.playlist_order`, independiente del orden de
claves JSON. Nombres nuevos se incorporan de forma determinista; renombrar conserva
posición. Validar todo el payload antes de modificar evita renombres parciales
cuando tracks o cover son inválidos. Los endpoints históricos conservan contrato.

El recorrido APK debe observar el estado actualizado de la UI antes de capturar
la siguiente operación, además de comprobar servidor: una respuesta de escritura
no garantiza que su refresh ya haya llegado. Ver HANDOFF para resultados concretos.
No cierra la paridad de biblioteca ni habilita alpha: otras acciones, DJ, Live,
Auto y distribución mantienen sus gates.
