# S2m: Radio NORMAL propiedad del servicio

Radio genera recomendaciones musicales por `/api/discovery/music/plan`; no es
un catálogo de emisoras. El servicio conserva seed, perfil, historial reciente,
petición cancelable y temporizadores mientras la WebView no está activa.

Activar sobre la canción actual conserva su ocurrencia, posición e intención de
pausa. El planner añade candidatos detrás de lo pedido manualmente; append manual
inserta antes de la primera recomendación futura. Stop Radio retira sólo sus
ocurrencias futuras, conservando canción actual e inserciones manuales. Cambiar
perfil cancela y replantea desde la canción actual. Reemplazar programa o cerrar
cancela la planificación en el mismo looper del servicio.

Lookahead máximo ocho, refill al quedar cinco o menos; deduplicación sobre cola
real e historial acotado de ochenta IDs. Respuesta y metadata tienen límites;
rechazar source desconocido, ID preview inválido, metadata desmesurada o podcasts.
Reintentos temporales 2/5/15/30/60 segundos con Retry-After acotado; eventos del
player no eluden la espera. Auth/permisos no son reintentos automáticos.

Estado radio y preview comparten session extras sin borrarse mutuamente. El puente
sólo devuelve estado/metadatos, sin cookies ni direcciones de proveedor. La cola
sustituida se confirma por IPC, incluido nuevo token de ocurrencias para un replay
con IDs idénticos; acknowledgment del comando solo no demuestra snapshot actualizado.

Pruebas: pool local/planner/final stream reales con archivos sintéticos; fixture
añade datos sólo al solicitar su endpoint privado y preserva el resto de tests.
HTTP/HTTPS APK deben confirmar seed estable, pausa/posición, fila manual,
deduplicación, Activity recreation y Stop Radio. Añadir refill/background real,
fallos/Retry-After, cancelación/cuenta y paridad UI antes de considerar Radio cerrado.

Este documento describe implementación en curso, no aceptación completa. Consultar
HANDOFF para evidencia final. Autoplay, dirección/DJ, Live, Auto, acciones completas,
firma/actualización y publicación mantienen sus gates independientes. Seguir hasta
paridad; ningún checkpoint autoriza alpha parcial ni finalizar la tarea del usuario.
