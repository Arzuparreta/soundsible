# S4k — Agotamiento y cancelación del emisor en background

La prueba adopta una sala existente mediante resume409, reproduce música local
por el servicio y cierra la Activity. El fixture rechaza exclusivamente la
credencial de publicación del stream seleccionado y corta su publisher real.
Android hace tres intentos de reconexión, retira Live al agotarlos y deja intactos
la reproducción local y la ocurrencia de la cola. No continúa reintentando.

Retirar el rechazo y pulsar Go live vuelve a publicar en la misma sala. Un segundo
corte alcanza un intento rechazado; cerrar sesión cancela los retries pendientes,
retira la sesión del host y no deja publisher en MediaMTX. Se observan cinco
segundos sin nuevas autorizaciones. El test vuelve a autenticarse sólo para
eliminar su sala aislada con autorización firmada.

La intervención del fixture distingue lectura y publicación. No modifica la
política de producción ni simula el servicio, el socket o el transporte multimedia.
La aceptación HTTP/TLS y los checks normales se registran en evidence/s4k.json.
No demuestra cancelación de un POST inicial de creación de sala, aceptación
acústica física ni regresión principal/browser completa.
