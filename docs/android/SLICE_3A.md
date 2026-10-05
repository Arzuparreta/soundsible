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

## Frontera real de stream en Media3 actual

Revisión del source oficial de la dependencia actual, no prueba de runtime:
[DefaultAudioSink](https://github.com/androidx/media/blob/1.11.1/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/audio/DefaultAudioSink.java)
configura el pipeline pendiente, drena el anterior y hace flush con
AudioProcessor.StreamMetadata (timeline, periodUid, positionOffsetUs).
[MediaCodecAudioRenderer](https://github.com/androidx/media/blob/1.11.1/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/audio/MediaCodecAudioRenderer.java)
entrega timeline y MediaPeriodId al AudioSinkConfig.
[BaseAudioProcessor](https://github.com/androidx/media/blob/1.11.1/libraries/common/src/main/java/androidx/media3/common/audio/BaseAudioProcessor.java)
permite onFlush(StreamMetadata). Usar ese periodo para localizar el MediaItem
exacto y sus facts/contexto: evita aplicar la ganancia de la cabecera actual a
buffers decodificados anticipadamente del siguiente tema. No hace falta inventar
un dueño de audio ni envolver SampleStreams sólo para transportar identidad.

El processor debe permanecer activo incluso en unity para conservar tap y recibir
cambios de stream. Core confirma volume_leveling/dj_mixing en discovery/settings.
Prefs pueden cambiar durante un stream; identidad del stream se fija en flush,
preferencia vigente se lee por bloque dentro del scope nativo. Pasar al siguiente
stream no puede cambiar muestras pendientes del anterior antes de drenarlas.
Pruebas de boundary, seek, fuente cambiada y rechazo de cuenta/generación son
requisito: los sources documentados por sí solos no prueban integración funcional.

## DSP en fuentes durante browser4 S2ag (sin aceptación todavía)

ProgramPcmGain incorpora saturación PCM16 y rampa10ms por frame; ProgramPcmTap
mantiene8 bloques de máximo64KiB, consumidor fuera del hilo de audio, scope por
generación y exclusión de input Live. ProgramPcmProcessor usa onFlush(StreamMetadata)
para resolver facts/contexto exactos del periodo y copiar salida post-ganancia al
tap opcional. No almacena audio cuando no hay consumidor. NativeProgramOutput
permite attachment sólo dentro del proceso; no hay IPC/export ni lectura JS/mic.

PlaybackService instala el processor en su AudioSink existente y fuerza PCM sin
float bypass/passthrough/offload. ProgramLeveling confirma PATCH y GET del Core,
con worker/cola acotados, descarte de receipt por sesión/generación y estado visible
mediante SessionExtras. ProgramQueue copia facts de la fuente y referencia de
álbum sólo ante contexto explícito, sin adivinarlo por títulos.

Código pendiente de compilar/probar: no ejecutar Gradle/JVM/integration a la vez
que browser4. Native Track/contexto y Settings UI todavía sin conectar al acabar
estos cambios. Siete tests JVM nuevos preparados (kernel4/tap3), aún no ejecutados.
Sigue siendo gate la salida PCM real HTTP/TLS/WAV/FLAC, volume local independiente,
fronteras/seek/Activity/scopes y álbum/shuffle. No anunciar leveling ni captura
funcionales hasta evidencia; esto no entrega mezcla DJ ni emisión Live.

## Continuación: compilación y prueba de muestras

La base DSP compila y pasa27 tests JVM (20 anteriores + kernel4 + tap3), además
de lint: `/tmp/soundsible-s3a-native-foundation.log`. La conexión Solid de Settings,
facts y contexto explícito pasa la suite completa1550/196 en
`/tmp/soundsible-s3a-connected-full-ui.log`; browser4 S2ag precede estos cambios y
debe repetirse antes del PR final. Ningún resultado JVM sustituye la salida PCM.

ProgramPcmTest prepara dos casos HTTP/TLS sobre el AudioSink real del único
servicio. El fixture mide sus tonos con el R128 de producción y entrega facts
por `/api/library`; comprueba unity/no medido/medido, álbum ponderado/shuffle,
volumen local independiente, seek, Activity y background. WAV HTTP/TLS2 pasa en
`/tmp/soundsible-s3a-pcm-offline-program-native.log`, seguido de APK/test APK/JVM27/
lint normales sin CA temporal. Incluye copias medidas y reproducción offline
desde Songs y álbum con Core503. Los diagnósticos anteriores se conservan: nodos
durante resume, Refresh sin esperar biblioteca nueva e identidad anterior al
reemplazo. Se corrigieron las esperas sin relajar amplitudes ni deadlines.
FLAC HTTP/TLS2 también pasa, seguido de APK/test APK/JVM27/lint normales en
`/tmp/soundsible-s3a-pcm-flac-native.log`. Ver [evidencia](evidence/s3a.json).
OfflineStore conserva facts finitos al preparar la copia, junto con sus bytes;
no los sustituye al refrescar etiquetas porque podrían describir otra grabación.
Copias anteriores sin facts mantienen la política de no medidos. La preferencia
confirmada se cachea por perfil nativo. El protocolo force-stop posterior pasa
prepare1/offline1 en `/tmp/soundsible-s3a-pcm-restart-native.log`: servicio nuevo,
Core503 y pico PCM1893 sobre copia sin facts; APK/test APK/JVM27/lint normales
pasan. El test restaura la preferencia original del motor aislado al terminar.

Planes generados: Core adjunta facts de la grabación adquirida usando su hash,
consulta sólo items aceptados de la biblioteca de esa cuenta y no publica hashes.
Un fallo de caché conserva selección/orden y devuelve no medido. RadioPlan nativo
preserva facts finitos/duración sin inventar contexto de álbum. Python79 pasa
con planner real WAV/FLAC en `/tmp/soundsible-s3a-plan-measured-python.log`;
Radio HTTP/TLS mide la ganancia de una ocurrencia generada real. Radio/parser/
Autoplay6 pasa en `/tmp/soundsible-s3a-radio-leveling-native.log`, seguido de
APK/test APK/JVM27/lint normal. Repetir principal completa sobre commit limpio.
Después continuar con [ejecución DJ](SLICE_3B.md), no cerrar el objetivo.

Principal desde commit limpio4e5b981 preparada dirty=false:
`/tmp/soundsible-s3a-main-clean-native.log`. ProgramPcmTest HTTP/TLS falla al
esperar álbum de dos temas porque Radio de casos anteriores deja más adquiridos
en `member album`. No es verde dirigido extrapolable a la principal. Corregir
fixture con álbum PCM propio (dos grabaciones, sin retirar datos Radio/eventos),
repetir pruebas afectadas y principal. Mantener fuentes congeladas hasta terminar
el runner actual; el XML principal aceptado anterior sigue siendo73.

Ejecución terminó78/2 y exit1. El fixture ya usa `member PCM album` con soft/loud
propios; no cambia el álbum original ni borra Radio/eventos. Radio HTTP/TLS corre
antes de PCM HTTP/TLS y los cuatro pasan con la biblioteca ampliada, seguido de
APK/test APK/JVM27/lint normal, en
`/tmp/soundsible-s3a-pcm-isolated-album-native.log`. Repetir principal limpia.
