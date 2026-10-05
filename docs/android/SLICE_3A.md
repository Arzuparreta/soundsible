# S3a: nivelación y salida PCM antes de DJ/Live

Este archivo prepara la ejecución del DSP; no describe una capacidad entregada.
S2af conecta preferencias que ya producen efectos nativos (feedback, Learning,
Autoplay), pero nivelación/mixing siguen pendientes. No ofrecer esos switches
hasta comprobar salida real. Mantener principal/regresiones S2 y su evidencia.

## Contrato compartido que hay que preservar

- `ui_web/src/lib/loudness.ts`: fuente de verdad de la regla. Target -18 LUFS,
  techo -1 dBTP, corrección limitada, caída fija para no medidos, referencia de
  álbum sólo con cobertura suficiente y reproducción de álbum sin shuffle.
  No copiar el comentario antiguo de `Track` que dice unity para no medidos:
  contradice el código actual. Tampoco medir de nuevo desde Android ni anunciar
  medidas inexistentes. Off devuelve1 exacto.
- Hechos confirmados del motor: `Track.loudness_lufs/loudness_peak_dbtp`, lectura
  de biblioteca y `/api/loudness/request` advisory. La petición de medición nunca
  debe bloquear Play. Settings Core PATCH confirma `volume_leveling/dj_mixing`.
- `ui_web/src/lib/audio/mixer.ts`: equal-power, bass_swap/long_blend, filter_blend,
  echo_cut/direct; preroll/cues/rate limitado/retorno de rate; mantener fase y
  metadata dominante, cancellation, stalled incoming, manual Next y background.
  Activar mixing en Core no ejecuta esos efectos por sí solo.
- El volumen de escucha queda DESPUÉS de la captura de programa post-DSP. Una
  emisión Live no debe seguir el volumen local ni grabar el micrófono/altavoz.

## Primer bloque implementable y verificable

1. Regla de ganancia y PCM como módulos nativos pequeños, con vectores comunes
   a la regla TS: medido/no medido/inválido/off, peak ceiling y contexto de álbum.
   Transporte preserva occurrence keys y contexto exacto de la acción, sin inferir
   álbum sólo por títulos/una cola que casualmente tenga el mismo álbum.
2. En `PlaybackService.kt`, integrar procesamiento en el AudioSink del ExoPlayer
   existente. Hay un solo propietario actual; no iniciar otro AudioTrack sólo
   para probar DSP. No habilitar offload/float bypass que salte los procesadores.
   Admitir conversión/formatos reales, flush, seek, cambio de track y EOS sin
   retener buffers de una cuenta o una ocurrencia anterior.
3. Snapshot de preferencias confirmado y cancelable por conexión, actualizar
   current y cued siguiendo el mismo contrato de web; reset al retirar ownership.
   No aplicar metadata/gain del siguiente item antes de su stream real.
4. Tap PCM acotado post-procesamiento/pre-volumen, consumidor no bloqueante,
   sin acumular horas en memoria. Permite prueba de amplitud/continuidad y será
   punto de entrada de Live; no publicar almacenamiento/captura por defecto.
5. Prueba APK HTTP/TLS con WAV/FLAC sintéticos y Core real: samples distintos
   al activar nivelación, unity al apagar, pausa/seek/current/cued/background y
   Activity estables, fuente inválida/fallo recuperable. La prueba del tap confirma
   programa calculado; la aceptación acústica física sigue siendo independiente.
   Conservar controles OS, focus/noisy, offline y programa privado existentes.

## Mezcla: APIs contrastadas, decisión pendiente de spike

La aplicación ya usa Media3 en `android/app/build.gradle` (usar su versión real).
[CompositionPlayer](https://developer.android.com/media/media3/transformer/compositionplayer)
permite composiciones con efectos; API experimental y timeline de composición.
Su [source del tag usado por el repo](https://github.com/androidx/media/blob/1.11.1/libraries/transformer/src/main/java/androidx/media3/transformer/CompositionPlayer.java)
expone `setAudioSink/setAudioMixerFactory/setMediaSourceFactory`, pero
`setCompositionInternal` libera y recrea holders de secuencias. Por eso no dar
por resuelta una ruta DJ dinámica que se edita mientras suena.
`PlaybackAudioGraphWrapper/AudioGraph` son package-private en ese tag: no diseñar
un import público que luego no compile ni parchear librerías generadas/cacheadas.
[AudioMixer](https://github.com/androidx/media/blob/1.11.1/libraries/transformer/src/main/java/androidx/media3/transformer/AudioMixer.java)
sí es público y alinea/mixa buffers; integrar entradas, clock, backpressure y
salida sigue siendo trabajo nuestro. La elección exige spike PCM/controles y
fuentes privadas, no sólo un diagrama. Cualquier alternativa debe mantener una
salida de programa y metadata dominante coherentes en MediaSession.

Después: S3 completo planner/rutas/dirección/requests/transiciones, S4 Live con
listener independiente, S5 Auto con browse/control confiables, firma/update y
release gates. No cerrar el objetivo ni publicar alpha por acabar S3a.

## Base de regla en fuentes (todavía sin AudioSink)

ProgramLoudness.kt traduce la política existente, incluidos no medidos, off1
exacto, techo de peak, cobertura90% y contexto explícito de álbum sin shuffle.
`shared/contracts/loudness_gain.tsv` contiene vectores consumidos por ambos
clientes: el test TS pasa38 en /tmp/soundsible-s3a-gain-contract-native-url-ui.log.
Los tres tests JVM nativos nuevos también comprueban referencia ponderada,
missing context y cobertura. Pendientes de ejecución en build normal del
siguiente runner; no afirmar que pasan antes de ver resultados. El recurso TSV
es sólo recurso de test JVM, no un archivo de datos de usuario ni asset de APK.
No DSP/audio nuevo conectado todavía; la prueba de PCM y scope sigue siendo gate.

Regla JVM aceptada: normal build de /tmp/soundsible-s2af-autoplay-native.log
termina0 con20 tests JVM (17 anteriores+3 de regla), cero fallos/errores/omisiones.
Recurso común cargado desde classpath real, incluida referencia ponderada
0.5727297072924131 y cobertura/contexto. UI completa1536/192 pasa; test TS de
regla38 pasa. Base lista para integrarla después de principal limpia73+restart2;
no afirmar que ya afecta a muestras o captura del programa.
