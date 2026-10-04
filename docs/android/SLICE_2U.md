# S2u: selector de carátula del sistema

S2r/S2s prueban multipart real con un File sintético. S2u añade selección mediante
el selector OS, lectura del content URI concedido por el sistema y cancelación.

Implementación de prueba: [CoverPickerTest.java](../../android/app/src/androidTest/java/com/soundsible/android/CoverPickerTest.java).
Emulador API 36, motores reales HTTP/HTTPS, pulsación física de Upload cover,
Back y comprobación de editor conservado/carátula sin cambios. El test siembra
un PNG verde con borde magenta en MediaStore y pulsa su miniatura identificada
por ese patrón. No usa File/DataTransfer ni simula ActivityResult.

Photo Picker no expone el nombre del archivo y oscurece/remuestrea miniaturas.
La detección permite ese cambio de brillo, exige borde magenta en los cuatro
lados y rechaza patrones ambiguos. La comprobación posterior del bitmap privado
subido exige el color original, independientemente del aspecto de la miniatura.
Teardown restaura la carátula original y elimina sólo el PNG sembrado.

Sin permisos amplios de almacenamiento/cámara: contrato existente del sistema
con concesión por archivo. Emulador no equivale a todas las apps proveedoras,
versiones Android o fabricantes físicos. Guards de cuenta/editor se mantienen.

Estado: **dos tests HTTP/HTTPS pasan**, cero fallos/omitidos en API 36,
`/tmp/soundsible-s2u-native-stable.log`. El rebuild normal encontró exclusivamente
UseSdkSuppress en el test; corregido a @SdkSuppress(minSdkVersion=29), APK/test/unit/lint normal sin CA pasa en `/tmp/soundsible-s2u-normal.log`. No se cambió lógica del caso aceptado.
Sources UI preparados desde cf01599 limpio; instrumentación S2u durante desarrollo.
Regresión principal previa: S2t35 más dos fases restart pasan desde cf01599 limpio.
Paridad completa, browser final, DJ/Live/Auto y firma/actualización siguen pendientes.
No publicar alpha parcial ni cerrar trabajo por slice.
