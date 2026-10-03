# S2n: favoritos y pertenencia a playlists

Favoritos se confirman en servidor, aparecen en la fila compartida y tienen una
vista de biblioteca. El menú conserva intención y cuenta. PUT favourites recibe
entry más boolean marked; repetir la petición no invierte el estado. Unmark de un
entry eliminado por otro cliente no lo vuelve a guardar. El endpoint toggle
existente conserva su contrato. Se respetan permisos/roles de library write.

El selector playlist comparte estilos y textos, conserva el archivo o preview
seleccionado y muestra fallo sin cerrar. Crear, guardar identidad preview y añadir
pertenencia requieren respuesta real. Un preview se guarda explícitamente, sin
adquirir audio; el motor admite pertenencia por ID y la identidad queda resoluble.
Sólo se cierra tras confirmar ID en la playlist y refrescar Library. Cambio de
cuenta aborta la petición y cierra selector y prompt; callbacks tardíos no migran.

La UI usa filas/virtualización existentes sin importar stores de audio web.
Offline no permite mutaciones remotas; conservar límites de Offline B. Gestión
completa de playlists (rename/delete/order/cover/remove), metadatos, entidades,
adquisición/importación y demás matriz permanecen pendientes.

Evidencia de unidades y rutas en HANDOFF. El APK debe confirmar HTTP/HTTPS,
favourite → filtro → unmark conservando archivo, create playlist y pertenencia
real, ausencia de audio HTML y aislamiento/cancelación. No dar el flujo por
aceptado por su compilación ni por un mock de UI.
