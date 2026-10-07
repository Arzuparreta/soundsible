# S2q: autoplay NORMAL propiedad del servicio

Implementación y aceptación en curso; consultar HANDOFF para resultados concretos.

Fuente de preferencia: GET/PATCH `/api/discovery/settings`, campo booleano
`autoplay_enabled`; el motor por defecto lo activa. Cargar con la cuenta y generación
actuales, confirmar PATCH y conservar errores. Una respuesta de otra sesión nunca
puede activar recomendaciones. No depender de timers WebView.

Referencia de producto: `stores/dj.ts::ensureAutoplay` y
`lib/generatedQueue.ts::ensureAutoplay`. Plan intent `autoplay`, perfil balanced,
lookahead ocho; preparar sólo al quedar dos o menos peticiones manuales futuras,
refill al quedar menos de cinco recomendaciones. Seed: última recomendación futura,
si existe; en su defecto última petición manual resoluble, luego actual. Nunca
podcast, repeat distinto de off, Radio o DJ. Inserción manual tiene prioridad.

Mantener fuentes/posición/pausa durante prepare/refill. Desactivar retira sólo
futuras ocurrencias autoplay y cancela worker/timer. Cambiar cuenta, sustituir o
cerrar programa invalida respuestas; no revivir autoplay sobre una cola vacía.
Reintentos temporales acotados, 401/403 sin retry automático, historial/deduplicación
y límites de la cola compartidos. Preferencias indisponibles no equivalen a true.

Tests reales HTTP/HTTPS: preferencia desactivada conserva cola exacta, activada
planifica/continúa; umbral de peticiones manuales, append prioritario, repeat,
podcast, Radio, desactivación, background/refill, cierre/cuenta durante petición.
Fixtures de recorridos deterministas deben fijar su preferencia explícitamente,
no modificar el default de producto para proteger assertions históricas.

Antes de implementar, revalidar fuentes: UI puede haber avanzado desde este
inventario. La matriz PHONE/DJ/Live/Auto y firma/release sigue siendo obligatoria.

El servicio comparte decoder, límites y retry con Radio, con intent y ocurrencias
separados. Tras una tanda corta vuelve a comprobar el umbral: no esperar otro
evento del player para rellenar. Preferencias desconocidas o fallidas no activan
planificación; menú ofrece recarga. Una escritura fallida conserva la preferencia
confirmada anterior y expone error. Cambiar Radio suspende explícitamente autoplay
antes de solicitar otro plan, sin borrar la preferencia. Cambios de cuenta y
callbacks pendientes se guardan por serial/generación. El seed futuro no modifica
la ocurrencia ni posición actuales.

El menú de tres puntos del programa cambia la preferencia real, sin toggle
optimista. La cola distingue Autoplay de Radio. Perfil autoplay es balanced; no
es un selector de perfil DJ. No marcar autoplay completo hasta comprobar también
podcasts, cancelación/cuenta con petición pendiente y recuperación extendida.
