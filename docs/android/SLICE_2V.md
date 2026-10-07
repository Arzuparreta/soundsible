# S2v: carátula editada frente a artwork embebido

El BitmapLoader de Media3 instalado prioriza artworkData sobre artworkUri.
Los nuevos endpoints de etiquetas/sidecar mantienen el archivo de audio intacto;
por tanto un FLAC con su portada original embebida puede ocultar la edición en
sesión multimedia/notificación aunque la biblioteca muestre el sidecar nuevo.

ProgramArtwork override loadBitmapFromMetadata da prioridad a URI privadas
soundsible-artwork. Reutiliza transporte autenticado, generation guards y caché
acotada; una URI privada caducada falla sin recuperar bytes embebidos antiguos.
Metadata sin URI privada mantiene el comportamiento de imagen embebida y sin
imagen devuelve null. No se reescribe música para cambiar una portada.

Aceptación instrumentada:
- ArtworkTest: URI privada roja con embedded azul muestra roja; sin URI conserva
  azul; sin ambas devuelve null; logout invalida URI privada aunque queden bytes.
- MetadataTest: FLAC real con portada roja embebida, comprobar esos bytes originales con MediaMetadataRetriever
  sobre una copia temporal acotada del FLAC autenticado; editar a verde por multipart, exigir verde también en
  sesión multimedia del sistema y mantener SHA-256 de audio/ID/cola/posición/copias.
- HTTP y HTTPS con CA temporal, luego APK/test/unit/lint normal sin CA.

Fixture opcional FLAC ahora lleva artwork embebido mediante AudioProcessor real.
Radio fixture copia archivos según el formato real, con regresión Python WAV y
FLAC, para no prometer soporte FLAC dejando rutas .wav hardcodeadas.

La metadata fusionada entregada por MediaController puede omitir artworkData
cuando la app aporta URI. No asumir que refleja todos los tags del archivo;
comprobar por separado archivo codificado y sesión del sistema. Primer intento
falló por esa suposición, no se declara aceptado.

Estado: **cuatro casos HTTP/HTTPS pasan**, cero fallos/omitidos, FLAC con imagen
embebida y sesión multimedia real en API 36. Log /tmp/soundsible-s2v-embedded-source.log;
APK/test/unit/lint normal sin CA pasa al terminar el helper. Python Radio WAV/FLAC
**dos tests pasan**, /tmp/soundsible-s2v-radio-fixture.log. No extrapolar a escucha
física o todos los formatos/decodificadores. Fuentes
UI preparadas desde cf01599; instrumentación/servicio cambiados en working tree.
No cambia gates de alpha: resto de paridad, DJ/Live/Auto y firma/update pendientes.
