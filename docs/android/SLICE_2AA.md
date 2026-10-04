# S2aa: eliminar un archivo adquirido desde Android

Plan de continuación después de cerrar la regresión de S2z. Todavía no
implementado ni validado; no cuenta como paridad ni como gate de publicación.

Añadir la acción existente «Eliminar archivo» sólo al menú de tres puntos de una
canción adquirida. Compartir las traducciones y confirmación de la UI actual.
Cancelar la confirmación no hace ninguna petición. Una cuenta desconectada o
sin permiso no ofrece una escritura ejecutable. Capturar el scope de cuenta;
ninguna respuesta antigua puede modificar la cuenta siguiente.

Usar DELETE /api/library/tracks/<id> y comprobar un snapshot privado posterior
que ya no contiene ese archivo. No borrar optimistamente la fila. El motor
conserva sus reglas de ownership y referencias del pool compartido. Un fallo de
API conserva biblioteca, programa y copia; no mostrar éxito antes de confirmar.

Retirar todas las ocurrencias nativas cuyo source sea local y cuyo ID sea el
archivo eliminado. No retirar previews aunque su identidad musical resuelva a
la misma canción. Hacer la mutación en el looper del servicio, validando epoch y
UID. La retirada por ID es global a la cuenta y no depende de un orden que pueda
cambiar con un refill; las ediciones por ocurrencia mantienen token/key. No
reconstruir toda la cola desde JavaScript. Conservar keys de
las ocurrencias restantes, posición y intención de reproducción si no se borra
la actual. Si se elimina la actual, comprobar la selección siguiente y la
intención de pausa/play. Si no quedan filas, cerrar el programa y sus modos.
Observar el estado efectivo del MediaController antes de resolver el bridge.

Revisar las respuestas pendientes de Radio/autoplay para impedir que una
planificación antigua reintroduzca el archivo retirado. La navegación y los
previews restantes siguen disponibles. Retirar también la copia offline y sus
referencias a playlists tras confirmar la eliminación privada; un fallo local
debe quedar visible y ser recuperable, nunca ocultarse como éxito completo.

Aceptación: tests de control de cuenta, confirmación/cancelación, fallo HTTP y
snapshot no confirmado; pruebas nativas HTTP y HTTPS con motor real, archivo
adquirido por el pipeline y copia offline. Cola con preview actual pausado a
20 s y varias referencias locales: eliminar el adquirido conserva preview,
key, posición y pausa, elimina todas las referencias locales y la copia.
Eliminar la actual prueba sucesor; eliminar la última prueba cierre. Comprobar
que otra cuenta mantiene sus archivos y que no aparece audio HTML. Validar los
modos pendientes afectados con pruebas específicas, sin afirmar aceptación de
hardware. Preparar assets antes de instrumentación, retirar la CA temporal,
validar APK/unit/lint normal y guardar evidencia del commit preparado.

Después: continuar Library/Discover/Settings completos, DJ, Live, Android Auto,
firma y actualización. Sólo con todos los gates completos: PR, main y alpha.

Primer controlador preparado (todavía sin acción de menú ni bridge de retirada):
fileDeletion.ts confirma DELETE y GET privado no-store antes de limpiar programa
y copia. Una respuesta 404 permite reintentar cleanup de una eliminación anterior
sólo si el snapshot vuelve a probar ausencia. Coalescing por cuenta/ID; un fallo
local refresca la eliminación del motor, pero no devuelve éxito. Diez pruebas
cubren confirmación, rechazo, aislamiento y cambios de cuenta en cada fase.
La acción de menú está preparada con confirmDialog/traducciones/toast compartidos:
cancelar no escribe, cambio de cuenta invalida confirmación, sólo cleanup completo
anuncia éxito. Sus cuatro pruebas pasan. Todavía no está conectada a AndroidStart
porque falta retirar referencias en el servicio. UI completa pasa 1.454
tests/171 archivos (/tmp/soundsible-s2aa-scaffold-ui.log).
Lifecycle del motor: 12 pruebas pasan,
incluido pool compartido, rollback y recuperación de borrado físico. No cuenta
todavía como aceptación del slice; falta implementación/validación end to end.
