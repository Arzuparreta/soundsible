# S2u: selector de carátula del sistema

S2r/S2s prueban multipart real con un File sintético. Eso no acepta el selector OS,
la lectura de un content URI concedido por el sistema ni la cancelación al volver.

Siguiente aceptación: emulador API 36, motor real HTTP/HTTPS, pulsación física del
botón Upload cover (no File/DataTransfer ni callback de Activity simulado). Abrir
el selector del sistema; cancelar con Back y comprobar editor conservado y carátula
sin cambios. Elegir PNG sintético sembrado mediante MediaStore, recibirlo por el
callback normal Capacitor/WebView y confirmar bitmap privado verde en el motor.
Retirar ese archivo de prueba y restaurar cover del fixture en teardown.

Sin añadir permisos amplios de almacenamiento/cámara: selección mediante el
contrato existente del sistema y su concesión por archivo. Probar selector en
emulador no equivale a validar todas las apps proveedoras ni fabricantes físicos.
Actividad, cuenta y editor pendientes deben seguir sus guards, sin reanudar una
escritura cancelada. No presentar scaffold o simulación de callback como prueba OS.

La regresión principal S2t35+restart sigue pendiente mientras se prepara esta
aceptación. Mantener separadas sus fuentes/artifacts, guardar logs/evidencia y
continuar resto de paridad antes de PR/main/release. No alpha parcial.


Draft portable: [CoverPickerTest.java](drafts/CoverPickerTest.java), fuera de la
compilación APK hasta trasladarlo a androidTest. No se ha compilado ni ejecutado.
Incluye eventos táctiles reales, espera del paquete del selector, Back, MediaStore,
búsqueda por nombre de archivo y comprobación del bitmap HTTP/HTTPS. Si PhotoPicker
no expone nombre en accesibilidad, inspeccionar árbol del selector y ajustar la
selección del PNG sembrado; no elegir una foto arbitraria ni simular ActivityResult.
