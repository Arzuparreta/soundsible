# S5b: suscripciones Android Auto en segundo plano

**8/0 HTTP/TLS,50.108s**, runner exit0: CarEvents2 + CarLibrary2 + CarLegacy2 +
TransportReset2. APK/test APK/JVM54/lint pasan sin CA temporal.
[evidence](evidence/s5b.json) conserva hashes y el diagnóstico de revocación.

ProgramCarSubscriptions abre Socket.IO nativo sólo cuando hay suscriptores de
car. Connection/cookie y callbacks se atan a generation/identidad. Eventos Core
library/saved/favourites y conexión inicial agrupan refresh durante250ms; se
consulta metadata actual del perfil antes de notifyChildrenChanged. Son64 registros
y16 padres distintos como máximo. Un padre en vuelo se marca dirty y se repite
sólo ese padre: un fetch lento no crea un bucle de polling de todas las carpetas.
Desuscripción/desconexión elimina registros; el último cierra socket y cancela
trabajo. Reset/logout/destroy invalidan callbacks y recursos. Reconexión configurada
con5 intentos acotados; pérdida real de red/reconnect aún no probada.

CarEventsTest destruye Activity/WebView con música real reproduciéndose. Cambia
labels y crea/borra playlist mediante API Core; browser recibe eventos/children y
conteos actualizados. Conserva KEY y PCM. Tras unsubscribe, otra mutación no
notifica. HTTP y TLS, sin motor/cuentas reales.

Con la nueva suscripción hubo una carrera401: un browse de background podía
revocar la sesión antes del browse explícito. Ahora todos los futures pendientes
reciben autenticación expirada cuando401 es la causa; reset por desconexión conserva
su razón. Guard inicial de identidad tolera generation cambiada sin tirar excepción
del callback. El bloque moderno/clásico anterior pasa junto con los eventos.

Pendiente: pérdida/reconexión real, eventos del almacenamiento offline local,
Auto con cookie expirada sin401 observado, controles/metadata durante DJ y UID
externo/host. Actualizar children no demuestra refresco de etiquetas del programa
que ya suena. No es paridad completa ni aceptación de coche/escucha física.
