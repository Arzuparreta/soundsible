# S2aa: eliminar un archivo adquirido desde Android

Implementación conectada al menú de tres puntos, con confirmación y traducciones
compartidas. Cancelar no escribe. El controlador coalesce por cuenta/ID y exige
DELETE seguido de un snapshot privado no-store que pruebe ausencia. Un 404 sólo
permite recuperar una retirada anterior tras comprobar de nuevo esa ausencia.
Las respuestas de otra cuenta no modifican UI, programa ni copias.

`retireSource` valida UID/generación y retira todas las ocurrencias locales por
ID, conservando previews, keys de supervivientes e identidad del programa.
Media3 conserva posición/pausa cuando la actual sobrevive, selecciona sucesor
cuando se retira la actual y cierra modos/programa cuando queda vacío. El bridge
espera a observar la retirada efectiva. Radio/autoplay invalidan solicitudes
pendientes y excluyen fuentes locales retiradas; la aceptación específica de una
respuesta de planner deliberadamente retrasada sigue pendiente.

La copia se retira después de confirmar el motor. El store marca el trabajo
invalidado antes de borrar archivos, limpia todas las referencias de playlists y
conserva errores de almacenamiento para recuperación. No se anuncia éxito si
falla el filesystem. El gestor muestra el error de retirada y permite repetir
«Eliminar de este dispositivo», sin ofrecer preparación sobre un residuo roto.
Las copias borradas remotamente siguen conservándose y son elegibles para
retirada desde el filtro local; no se añade eviction automático.

La adquisición considera activos sólo pending/downloading: un recibo completado
no bloquea volver a adquirir una canción retirada. Los guards de cuenta y
confirmación durable siguen vigentes.

[Registro de evidencia](evidence/s2aa.json).

## Evidencia y límites

UI completa: 1.465 tests / 172 archivos pasan en
`/tmp/soundsible-s2aa-final-ui.log`. Backend lifecycle: 12 pasan en
`/tmp/soundsible-s2aa-lifecycle.log`. JVM nativo: 17 pasan en
`/tmp/soundsible-s2aa-native-unit.log`, incluidos rangos de retirada y filesystem
real con eliminación fallida/recuperación. El helper integration ahora ejecuta
`:app:testDebugUnitTest` además de APK/test APK/lint tras retirar la CA temporal;
ensamblar el APK de instrumentación no sustituye ejecutar los tests JVM.

Cuatro casos instrumentados HTTP/HTTPS pasan en
`/tmp/soundsible-s2aa-recovery-native.log`: pipeline real de adquisición, archivo
compartido entre cuentas, playlist con referencias duplicadas, cancelación,
preview pausado a 20 s conservado, sucesor, cierre de última canción, copia y
filesystem fallido/recuperable. Assets preparados desde 5ddc166 con dirty=true.
APK/test APK/lint normales pasan después de retirar la CA temporal.

La extensión de copia borrada por otro cliente pasó HTTP/HTTPS en
`/tmp/soundsible-s2aa-final-native.log`, pero el conjunto falló dos casos de
apertura del gestor. El aislamiento posterior identifica TypeError de WebView:
progress.value=undefined no es un double finito; HTTP falla y HTTPS pasa según
el momento en que llega el tamaño. Log `/tmp/soundsible-s2aa-manager-diagnostic.log`.
Ahora el tamaño desconocido renderiza progress sin value/max, y el conocido usa
números. Una prueba con el setter estricto falla con la fuente anterior y pasa
con la corrección (`/tmp/soundsible-s2aa-progress-before.log`). La repetición de
los cuatro casos está en `/tmp/soundsible-s2aa-progress-native.log`, assets desde
37d1669 dirty=true: cuatro casos pasan, cero fallos/errores/omisiones.
APK normal, test APK, JVM17 y lint pasan después de retirar la CA temporal. Repetir principal completa
más dos fases offline desde commit limpio. Ningún resultado acredita escucha
física ni paridad completa. Después continuar Library/Discover/Settings, DJ,
Live, Android Auto, firma y actualización; PR/main/alpha sólo al cerrar gates.
