# S3b: ejecución DJ nativa

Integración end-to-end en fuentes: comando `dj` de SoundsiblePlayback solicita
Core `/api/discovery/music/dj-plan` sin detener el programa durante la petición;
retry temporal acotado a60s y scope por cuenta/ocurrencia. ProgramDjSession
ejecuta ruta/cues sobre ProgramMixOutput, Player lógico conserva MediaSession,
focus/noisy único y tap NativeProgramOutput post-DSP/pre-volumen. El menú ofrece
From current. Native/test/JVM48/lint pasan en
/tmp/soundsible-s3b-dj-e2e-foundation.log. DjProgramTest HTTP/TLS real todavía
pendiente; no declarar DJ entregado. Dirección/refill/edición extendida,
phase correction y contratos OS/recuperación de producción requieren continuar.
From current reprepara la entrada con la posición actual; esta integración
no demuestra continuidad acústica al pasar de NORMAL a DJ.
Primer end-to-end HTTP/TLS2 falla en lectura del test de pausa: StartupTest
devuelve JSON.stringify como string JSON codificado; JSONObject lo rechazaba.
Ambos llegan a Core real, mezcla PCM en background y dominancia entrante antes
del fallo. Log /tmp/soundsible-s3b-dj-e2e-native.log, prepare sobre71ab534b dirty
(fuentes equivalentes al bloquef12f39fc). Se corrige lectura de posición en JS,
cleanup en finally y dirección inicial neutral. Repetir recorrido completo sobre
commit limpio; no aceptar esta primera ejecución parcial.
Segundo end-to-end sobre869b9018 limpio: HTTP/TLS2 falla después de validar pausa,
al usar awaitReady de StartupTest tras recrear una Activity ya autenticada. Ese
helper exige pantalla de conexión sin configurar; la app mostraba biblioteca y
programa DJ conservado. Log /tmp/soundsible-s3b-dj-clean-native.log. Se espera
biblioteca sin data-booting al recrear. Volver a ejecutar retorno NORMAL completo.
Tercero sobre19c1e216: HTTP completa el recorrido, TLS falla en stop. Diagnóstico
TLS dirigido sobre1399be65 confirma NetworkOnMainThreadException en
PlaybackService.closeProgram: evictAll cerraba SSL en hilo principal. Logs
/tmp/soundsible-s3b-dj-recreation-native.log y
/tmp/soundsible-s3b-dj-close-diagnostic-native.log. Transporte de audio recibe
pool/dispatcher propios y limpieza TLS en worker; shutdown libera su executor.
El test limpia también facts R128 originales y transforma rechazo en boolean
para evitar esperar45s cuando ya hay error. Repetir DJ y regresión NORMAL.

## Integración del servicio en curso

PlaybackService utiliza ProgramPlayerRouter (ForwardingSimpleBasePlayer) sobre
el ExoPlayer NORMAL existente. La sesión, listeners de programa y helpers reciben
la misma fachada. Sustituir backend requiere anterior parado/idle y siguiente
sin play solicitado; el caller conserva responsabilidad de liberar el retirado.
El backend DJ todavía no está conectado. Compilación Native/test, JVM48 y lint
pasan en /tmp/soundsible-s3b-router-tests-foundation.log; pruebas APK dirigidas y
regresión completa de servicio pendientes. No sustituir la evidencia S3a78.
Primer dirigido APK: 2 tests/1 fallo en
/tmp/soundsible-s3b-router-native.log. El fixture de forwarding creaba MediaItem
sin URI, que DefaultMediaSourceFactory rechaza incluso sin prepare. Se añade URI
de asset sintético, sin prepare ni lectura, manteniendo el test de eventos y
controles; repetir antes de aceptar. Primer intento sin emulador no ejecutó tests.

## Punto de partida

S3a entrega nivelación y salida PCM de un stream Media3: ver evidencia/s3a.json.
No entrega solapamiento, técnicas DJ ni emisión Live. Los planes NORMAL actuales
usan el servicio nativo y su runway; no confundir Radio con una sesión DJ.

## Contrato que debe implementar el siguiente bloque

Leer `ui_web/src/stores/dj.ts`, `lib/generatedQueue.ts`,
`lib/audio/contracts.ts`, `lib/audio/mixer.ts` y `lib/audio/graph.ts`.
El planner selecciona y describe transiciones; el servicio ejecuta cues,
preroll, rate, phase correction, pausa y cancelación aunque Solid esté suspendido.
Las técnicas son direct, safe_fade, structural_fade, bass_swap, filter_blend,
long_blend y echo_cut. El nombre de una técnica o un switch Core no prueba efecto.

La salida sigue teniendo un propietario y una MediaSession. Dos decodificadores
pueden ser entradas de una mezcla, pero no dos salidas audibles independientes.
Ambas entradas usan fuentes nativas privadas, preparación/reintentos acotados y
ocurrencias distintas; no exponer cookies ni abrir audio HTML en paralelo.
El stream final requiere nivelación por entrada, EQ/filtro/echo, mezcla y limiter,
con tap post-DSP/pre-volumen. Conservar NORMAL/offline/podcasts y focus/noisy.

Antes de elegir implementación, resolver en un spike ejecutable:

1. Decodificar dos fuentes reales y alinear muestras con un reloj de salida;
   comprobar backpressure, cambios de formato, pausa, seek y fin del saliente.
2. Mantener salida continua al cambiar dominancia y metadata. No liberar y
   recrear el dueño audible en cada edición de la ruta ni reiniciar el entrante.
3. Editar/replanificar sólo tramos no comprometidos. Occurrence keys, programToken,
   dirección vigente y fromKey gobiernan receipts/cancellation; un fallo entrante
   deja audible el saliente y conserva recuperación explícita.
4. Medir ambas frecuencias durante equal-power y comprobar técnicas/limiter sobre
   PCM, control OS, background y scope de cuenta. Después integrar UI/planner.

CompositionPlayer actual reconstruye holders al sustituir composiciones; sus
clases AudioGraph/PlaybackAudioGraphWrapper son package-private. S3a documenta
las APIs oficiales contrastadas. No asumir que una composición estática acepta
una ruta dinámica ni parchear librerías generadas para aparentar API pública.
AudioMixer público tampoco resuelve solo ownership, reloj y controles.

## Aceptación posterior

Sesión contextual/nueva, dirección, fuentes, requests, reordenar/repair, retries
temporales sin cortar lo actual, manual Next, pausa/seek, Activity/background,
cancelación y salida privada. Inventariar acciones actuales antes de declarar
paridad. Live escucha/emisión con listener independiente y Auto/DHU vienen
después; firma/update y gates completos permanecen obligatorios para alpha.

Este documento es contexto de continuación, no evidencia de DJ implementado.

## Spike preparado durante la regresión S3a

Se contrastaron las APIs del tag real de la dependencia:
[AudioOutputProvider](https://github.com/androidx/media/blob/1.11.1/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/audio/AudioOutputProvider.java),
[AudioOutput](https://github.com/androidx/media/blob/1.11.1/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/audio/AudioOutput.java)
y sus forwarding públicos. DefaultAudioSink convierte/procesa antes de solicitar
el output. Esto permite probar entradas sin AudioTrack propio y un dueño común;
no demuestra aún dominancia dinámica ni integración con el servicio.

Principal S3a limpia78+restart2 está aceptada; fuentes del spike ya integradas:
ProgramMixCurve, ProgramDeckEffects, ProgramMixLimiter y ProgramMixOutput, con
sus tests JVM y ProgramMixOutputTest instrumentado aislado. Compilan Native/test
Kotlin; JVM36/0 y lint pasan en /tmp/soundsible-s3b-mix-foundation-fixed.log.
El primer compilado falló sólo por llamadas Java antiguas OkHttp en Kotlin;
corregido usando las extensiones instaladas. No se ha probado aún AudioTrack real.

Cada decoder normaliza canales mono/estéreo con matriz constant-gain y Sonic48k
antes de entrar en el output común. El fixture admite secondFrequency880,
secondRate48000 y secondChannels2 con valores estrictos; los tests S3a conservan
440/16000/mono. La prueba mide amplitudes 440/880 en PCM y comprueba volumen local
independiente y liberar el decoder saliente sin recrear el dueño audible.

Filtros usan coeficientes normativos [Web Audio](https://www.w3.org/TR/webaudio-1.0/#filters-characteristics):
Q=0.7 del lowpass está en dB, no es calidad lineal. La prueba de resonancia en
cutoff distingue ambas fórmulas. EQ/lowpass/eco/limiter están en el spike, todavía
sin aceptación acústica ni equivalencia exacta del DynamicsCompressor de navegador.

No declarar funcional el grafo por curvas unitarias o un solo crossfade: faltan
prueba HTTP/TLS real, EOS/backpressure, scope, pausa/seek y dominancia sobre reloj
de playout. El master reserva los frames del buffer en curso antes de permitir
nuevo blend; no programar sobre muestras ya comprometidas. Cambiar metadata cuando
se calcula un buffer futuro confundiría al oyente. Luego integrar controles/colas
y planner DJ y revalidar los flujos NORMAL anteriores. Continuar hasta los gates
completos; dejar PR abierta con checks pasando para review manual, sin automerge.

Primer AudioTrack HTTP/TLS falla2: proveedor compartido accedido desde dos loopers
ExoPlayer y cleanup desde instrumentation sin Looper. Log
/tmp/soundsible-s3b-mix-native-jdk21.log. No sustituye principal S3a78 verde.
Owner ahora proporciona un HandlerThread común de decoding, ambos ExoPlayer lo
usan y la liberación de AudioTrack/proveedor se agenda allí, esperando onReleased
antes de cerrar el hilo. Kotlin/test/JVM36/lint pasan en
/tmp/soundsible-s3b-mix-looper-foundation.log; repetir AudioTrack real antes de
aceptarlo. El rechazo inicial de JDK sistema se conserva como diagnóstico en
/tmp/soundsible-s3b-mix-native.log, sin instrumentación ejecutada.

Segunda ejecución real aceptada: HTTP/TLS2/0/0/0 sobre prepare limpio16ed5d83,
log /tmp/soundsible-s3b-mix-looper-native.log. Ambos formatos distintos se
normalizan; amplitudes440/880 medidas durante equal-power; volumen local0.1 no
cambia el tap y liberar el saliente conserva el entrante. APK/test APK/JVM36/lint
normales después de retirar CA pasan. Ver evidence/s3b.json. Es todavía un spike
isolado: continuar pausa/seek/EOS/starvation/scope y técnicas, después fachada
Player/MediaSession y planner; no describir DJ de producción como entregado.

Ampliación en fuentes: acceso al dispositivo serializado (write/control/clock/
release), pausa/reanudación con reloj físico y revocación por clearSession real,
no un flag de UI. Limpieza de fixture ocurre antes de borrar la sesión; ninguna
petición de audio sigue autorizada después. Compilación Native/test, JVM36 y lint
pasan en /tmp/soundsible-s3b-mix-pause-foundation-fixed.log. Primer compile de
estas aserciones falló por usar Long con overload JUnit Double; corregido a
comparación acotada de microsegundos. Aceptación HTTP/TLS ampliada pendiente.

Ampliación pausa/scope aceptada HTTP/TLS2/0 en
/tmp/soundsible-s3b-mix-pause-native.log sobre4b6489ee limpio: reloj físico parado
al pausar, reanudación, clearSession real invalida/pausa/flush; build normal sin CA
APK/test APK/JVM36/lint pasa. Siguiente seek con marcador audible sintético1320Hz
tras4s para distinguir muestras anteriores del salto; aún sin aceptación.

Seek en fuentes: epoch invalida buffers reservados y flush de AudioTrack al
resetear el deck activo; el standby mantiene prebuffer y reloj congelado. Escritura
serializada revalida epoch dentro del lock del dispositivo. El fixture opcional
firstMarker genera440Hz antes de4s y1320Hz después; facts R128 se miden sobre el
archivo real. Test seek10s exige nuevo epoch y marcador1320 en PCM, reloj físico
reiniciado, y conserva el posterior blend. Compilación/test/JVM36/lint y Ruff
pasan en /tmp/soundsible-s3b-mix-seek-foundation.log; Native ampliado pendiente.

Primer seek Native HTTP/TLS2 falla porque Media3 sustituye/libera la entrada,
sin llamar flush del wrapper. Log /tmp/soundsible-s3b-mix-seek-native.log; no
aceptar seek ni reemplazar resultado anterior de pausa. Corrección invalida el
buffer físico y el epoch también al liberar/sustituir entrada activa, de forma
idempotente; liberar el saliente ya inactivo sigue conservando el master.
Kotlin/test/JVM36/lint pasan en
/tmp/soundsible-s3b-mix-seek-replacement-foundation.log. Repetir marcador real.

Seek repetido aceptado HTTP/TLS2/0 sobre6d0626a0 limpio, log
/tmp/soundsible-s3b-mix-seek-replacement-native.log; epoch nuevo, PCM1320 tras
seek10s, reloj master reiniciado y blend posterior coherente. Pausa/revocación
siguen pasando; APK/test APK/JVM36/lint normales sin CA pasan. No prueba acústica
ni integración MediaSession; siguiente dominancia física y recuperación entrante.

Ventana de playout en fuentes: ProgramMixWindow conserva start/length/decks/epoch
para resolver dominancia con posición física, independiente de promoción anticipada
del render. Invalidate elimina la ventana. DIRECT cambia input sin consumir frames
entrantes durante un falso overlap; volumen/AudioTrack único se conservan. Test
Native amplía a cuatro casos HTTP/TLS fade/direct: dominancia25%/75% y cue de
entrada direct sin salto. Compilación Native/test/JVM38/lint pasan en
/tmp/soundsible-s3b-mix-direct-foundation.log; prueba real ampliada pendiente.

Dominancia/direct aceptados HTTP/TLS4/0 sobre5f762ba1 limpio, log
/tmp/soundsible-s3b-mix-direct-native.log. Metadata sigue reloj físico25/75%,
DIRECT no consume cue entrante como overlap, seek/pause/scope siguen pasando.
APK/test APK/JVM38/lint normales después de retirar CA pasan. Siguiente caída
entrante durante blend sin cortar saliente, EOS/técnicas, luego fachada/planner.

Recuperación en fuentes: liberar entrante comprometido durante blend conserva
AudioTrack y buffers ya válidos, vuelve al saliente retenido con rampa150ms de
ganancia/EQ/filtro/echo, libera limiter gradualmente y agenda dominancia restaurada
en el frame que llegará al dispositivo. No vaciar programa ante fallo de standby.
Test ampliado a seis casos incluye desaparición real de ExoPlayer entrante HTTP/
TLS, PCM del saliente y pausa/scope posteriores. Kotlin/test/JVM38/lint pasan en
/tmp/soundsible-s3b-mix-recovery-foundation-fixed.log; primer compile del nuevo
predicate falló por trailing lambda JUnit, corregido a variable explícita.
Native6 pendiente. Antes de producción añadir mapping de reloj por tramos para
retomar un deck después de un hueco sin cambiar su posición antes del playout.

Recuperación entrante aceptada HTTP/TLS6/0 sobref001e95a limpio, log
/tmp/soundsible-s3b-mix-recovery-native.log. Decoder entrante se libera durante
fade; tap confirma saliente restablecido y dominancia sobre playout; seek/pause/
scope y normal APK/test APK/JVM38/lint pasan. No equivaler a red/proveedor vivo ni
recuperación tardía después de hueco; siguiente clock mapping por tramos y Native8.

Reloj por tramos en fuentes: ProgramDeckClock mapea reservas a frames realmente
reproducidos de cada deck, congela posición durante huecos y no mueve el reloj
anterior al reservar una vuelta futura. Spans contiguos se coalescen; historial
máximo64, sólo se poda tras alcanzar el siguiente tramo físico; reset descarta
el epoch previo. Source.getPositionUs usa ese mapping, no reajusta joinedAt al
recuperar. Kotlin/test/JVM41/lint pasan en
/tmp/soundsible-s3b-mix-clock-foundation.log. Native amplía a ocho casos con caída
tardía95% y comprobación de no retroceder el clock del saliente; aceptación pendiente.

Primera clock Native8 falla2 sólo en caída tardía: liberar el deck que ya controla
render pausa AudioTrack; recuperar old Source no reanudaba el dispositivo. Log
/tmp/soundsible-s3b-mix-clock-native.log; principal aceptada del spike sigue6.
Corrección reanuda master retenido si no hay pausa deseada, sesión sigue propia
y no hay error fatal; callback de entrada liberada no pausa ni flushea reemplazo.
Kotlin/test/JVM41/lint pasan en /tmp/soundsible-s3b-mix-clock-resume-foundation.log.
Repeat Native8 pendiente; no afirmar aceptación tardía ni clockmapping real todavía.

Clock/recovery tardía aceptados HTTP/TLS8/0 sobreca242c26 limpio, log
/tmp/soundsible-s3b-mix-clock-resume-native.log. Recurso entrante se pierde al95%,
clock saliente no retrocede, master reanuda y PCM/dominancia vuelven al retenido.
Normal APK/test APK/JVM41/lint sin CA pasa. No afirmar aún integración servicio,
planner, restantes técnicas ni EOS. Continuar Native FX y luego fachada/planner.

FX Native en pruebas (pendiente): fixture firstFrequency80/100 opcional genera
archivo real20s con facts R128 medidos; defaults anteriores intactos. Bass swap
mide atenuación80Hz con4400Hz entrante; filter/long comprueban entrada filtrada
antes del midpoint y long combina bass swap; echo usa100Hz (28 ciclos/280ms) y
retorno distinguible al final; structural_fade usa equal-power. Clase amplía a18
casos HTTP/TLS de siete técnicas y recuperación. Kotlin/test/JVM41/lint y Ruff
pasan en /tmp/soundsible-s3b-mix-fx-foundation.log. No tempo/phase correction,
EOS ni integración planner/MediaSession aceptados; no equiparar nombres a paridad.

Primer Native18 falla1 (tlsStructuralFade): el primer bloque saliente llega antes
del PCM entrante, blend rechazó input no listo. Resto17 sin fallos, pero clase
no aceptada; log /tmp/soundsible-s3b-mix-fx-native.log. API readyInput comprueba
propiedad/generación, ausencia de fatal, playing y50ms de PCM. El cruce exige esa
condición; test usa espera acotada5s sobre datos reales mientras saliente continúa.
Kotlin/test/JVM41/lint pasan en /tmp/soundsible-s3b-mix-fx-ready-foundation.log;
repetir clase18 antes de aceptar técnicas.

Clase Native18 aceptada sobree0499c4e limpio, log
/tmp/soundsible-s3b-mix-fx-ready-native.log: siete técnicas HTTP/TLS con espectros
reales, readiness y clock/seek/recovery/pause/scope. Normal APK/test APK/JVM41/lint
sin CA pasa. No confundir structural_fade equal-power con tempo/cues/phase del
planner aún no conectado. Siguiente WAV+FLAC real, EOS y ejecución temporal nativa.

FLAC en fixture/test: secondFormat opcional wav/flac codifica el tono sintético
con ffmpeg, retira WAV y registra formato/tamaño/facts del archivo comprimido real.
Defaults intactos. Tests httpFlacMix/tlsFlacMix usan mismo grafo con WAV mono16k y
FLAC estéreo48k, mid/final PCM, seek/clock/pause/scope. Kotlin/test/JVM41/lint y
Ruff pasan en /tmp/soundsible-s3b-mix-codec-foundation.log. Codec Native dirigido2
pendiente; clase ampliada20 no sustituye18 hasta repetirla si se requiere.

Codec dirigido2/0 aceptado sobref5178e54 limpio, log
/tmp/soundsible-s3b-mix-codec-native.log: WAV mono16k + FLAC estéreo48k por HTTP/
TLS, dos decoders normalizados, PCM mix/seek/clock/pause/scope y normal APK/test/
JVM41/lint pasan sin CA. Resultado dirigido separado del18 de clase previa.
Siguiente EOS con entrante preparado, tempo/phase, fachada Player y planner.
API instalada ForwardingSimpleBasePlayer permite setPlayer protegido: candidata
para router de MediaSession que preserve comportamiento NORMAL; contrastar y
probar antes de integrar, no reconstruir controles previos por suposición.

EOS en fuentes/test: drainedInput exige ended, queue vacía y todos los frames
reservados alcanzados por hardware. DIRECT reanuda el master propio si no hay
pausa deseada/fatal, para relevar un renderer que Media3 pausó al terminar.
httpEndOfSource/tlsEndOfSource seek19.5s del archivo20s, esperan drain real y
STATE_ENDED, y cortan a entrada ya preparada sin consumir su cue. Kotlin/test/
JVM41/lint pasan en /tmp/soundsible-s3b-mix-eos-foundation.log; Native EOS2 pendiente.

EOS inicial HTTP/TLS2 falla: último PCM no alcanza el reloj físico antes de la
pausa del decoder. Diagnóstico dirigido HTTP1 sobre078e94fa: ended=true, queued=0,
supplied=24000, played=19632, playing=false. Logs
/tmp/soundsible-s3b-mix-eos-native.log y
/tmp/soundsible-s3b-eos-diagnostic-native.log. No aceptar EOS todavía.
El owner ignora la pausa de estado ended del decoder y permite vaciar su cola;
la pausa explícita de programa sigue siendo efectiva. Kotlin Native/test,
JVM41 y lint pasan en /tmp/soundsible-s3b-eos-tail-foundation.log. Repetición
HTTP/TLS pendiente; no sustituye evidencia anterior de técnicas/FLAC.

Repetición con pausa ended separada sigue fallando HTTP/TLS2: played19633 de
24000 incluso playing=true, log /tmp/soundsible-s3b-eos-tail-native.log. El reloj
AudioTrack descontado de latencia se congela al underrun sin nuevas escrituras.
La siguiente corrección escribe silencio sólo hasta drenar los frames reales;
no cuenta ese silencio en el reloj de medios del deck ni llama AudioOutput.stop
(dicho output no reanuda PCM tras stop sin flush). EOS sigue pendiente de prueba.

EOS aceptado HTTP/TLS2/0 sobref180e8ea limpio, log
/tmp/soundsible-s3b-eos-silence-native.log: PCM real24000 frames drenado antes
de STATE_ENDED, relevo DIRECT a cue preparado, pausa/scope conservados. Normal
APK/test APK/JVM41/lint sin CA pasa. Próximo tempo/phase y después servicio/planner.

Tempo aceptado HTTP/TLS2/0 sobreb2e208b8 limpio: PCM1600Hz conserva pitch con
speed1.05, reloj Exo de medios corresponde a frames de salida ajustados por
velocidad. Se conserva seek/blend/pausa/scope; normal APK/test APK/JVM41/lint
pasa. Log /tmp/soundsible-s3b-tempo-native.log. No prueba todavía cues/phase ni
retorno progresivo de rate después del blend; producción DJ sigue pendiente.

Cue/preroll aceptado HTTP/TLS2/0 sobree7e36547 limpio, log
/tmp/soundsible-s3b-cue-native.log. Arm se agenda contra output reservado, divide
buffers en fronteras de preroll/cue/fin; consume500ms entrantes en silencio,
reloj común alinea entrada y metadata sigue playout durante overlap. PCM previo
no contiene tono entrante. Normal APK/test APK/JVM41/lint pasa. No prueba todavía
plan absoluto Core, corrección/cancelación ni servicio DJ; siguiente editar futuro.

Cancelación en fuentes: sólo antes de reservar PCM del overlap; nunca confundir
preroll audible todavía silencioso con mezcla no comprometida. Primera prueba
HTTP/TLS2 falla por intentar cancelación con250ms antes del cue físico pero el
render ya había reservado mezcla; el guard rechaza correctamente. Log
/tmp/soundsible-s3b-cancel-native.log. Ajustar prueba a preroll2s/margen1.75s,
mantener rechazo después de blend comprometido. La corrección no debilita el guard.

Cancelación/seek standby aceptados HTTP/TLS2/0 sobre53717d2f limpio, log
/tmp/soundsible-s3b-cancel-reservation-native.log. Cancelar futuro conserva
PCM1320 y epoch, seek del standby reinicia sólo su clock, nuevo arm mezcla y
rechazo de cancelación comprometida pasa. Normal APK/test APK/JVM41/lint pasa.
No integra aún controller/planner; próximo retorno de rate y fachada Player.

Retorno rate aceptado HTTP/TLS2/0 sobre5b5dbed8 limpio, log
/tmp/soundsible-s3b-rate-return-native.log. ProgramRateReturn vuelve1.05→1 en8s
de playout, no wall time; pausa mantiene rampa, progress monotónico y scope/epoch
cancela callback. PCM1600Hz conserva pitch; normal APK/test APK/JVM41/lint pasa.
El helper sigue en spike aislado, no habilita DJ en producción. Próximo niveles
por entrada y fachada Player/MediaSession/planner.

Regresión completa spike aceptada32/0 sobref2e7a921 limpio: siete técnicas,
WAV/FLAC/EOS, tempo/retorno, preroll/cancel/standby seek, pérdida early/late,
pausa/scope y niveles por entrada. Source levels0.5/0.75 se observan en PCM y
cambiar entrante a0.5 usa envelope10ms independiente de volumen local. Orden
igual que graph.ts: EQ/filter→level→dry y echo→master/limiter. Log
/tmp/soundsible-s3b-complete-spike-native.log, normal APK/test APK/JVM41/lint pasa.
Principal S3a78 no se ha repetido con el spike; no integrar todavía DJ ni alpha.

Diferencia encontrada con Core: shared/dj_engine.py permite overlap48s; spike
aceptado hasta ahora limita30s. Ampliar a rango60s y probar LongBlend48s completo
con fuente saliente90s, más política conservadora/fromKey antes de fachada Player.

Ampliación Core48s y ProgramDjPlan compilan; siete pruebas de política fromKey,
fallback, cue, límites tempo/phase y mezcla desactivada pasan (JVM48 total),
Ruff/lint pasan. Primer LongBlend48s HTTP/TLS2 falla después de la mezcla medida:
prueba libera saliente al observar PCM casi silencioso antes del fin completo,
porque low-shelf atenua su80Hz. Stack run:297 en
/tmp/soundsible-s3b-full-long-native.log. Esperar fin físico de ventana48s antes
de liberar el saliente; mantener los umbrales PCM y repetir. No aceptar48s aún.

LongBlend48s aceptado HTTP/TLS2/0 sobrebbfcd056 limpio, log
/tmp/soundsible-s3b-long-end-native.log: PCM80/4400 en25/75%, dominancia física,
ventana completa48s antes de liberar saliente y continuación del entrante.
Normal APK/test APK/JVM48/lint pasa. Core overlap no se recorta al antiguo30s.
Próximo caída saliente y luego fachada Player/servicio/planner; DJ productivo
sigue pendiente.

Pérdida de cualquiera de las entradas aceptada HTTP/TLS8/0 sobreb210eeb3
limpio, log /tmp/soundsible-s3b-outgoing-loss-native.log. Si cae saliente durante
blend, entrante sano continúa con EQ/dry restaurados150ms; no flush/epoch nuevo,
clock y metadata siguen playout. Caídas entrantes early/late siguen verdes.
Normal APK/test APK/JVM48/lint pasa. Preparar siguiente fachada Player estable,
focus/noisy único y conexión del servicio/planner; no DJ productivo aún.
