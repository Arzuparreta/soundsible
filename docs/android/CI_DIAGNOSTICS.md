# Diagnóstico del shard Android

El artefacto `soundsible-android-emulator-<shard>-<sha>` contiene JUnit,
logcat por caso en `app/build/outputs/androidTest-results/`, `build/fixture.log`
y `build/emulator.log`. Este último se captura continuamente desde antes de
las pruebas: conserva los casos iniciales aunque el buffer circular del
emulador se haya sobrescrito al terminar. El código de salida original se
conserva; no se reintentan ni se omiten casos automáticamente.

## Arranque de ADB y red del fixture

En la PR #426, run `42362004721`, los shards 2 y 5 terminaron antes de
instalar o ejecutar la app: tras `boot_completed`, ADB volvió temporalmente
a `device offline` al ejecutar `svc wifi enable` (salidas 255 y 1).
`scripts/android.py` fija el serial validado y da a ese comando de preparación
un presupuesto total de 30 segundos, con cada proceso limitado a cinco.
Solo los fallos transitorios de transporte/servicio se reintentan; errores
de permisos fallan de inmediato. Se conserva el último diagnóstico, incluida
una salida 255 sin texto. No se reintentan casos de instrumentación. Agotar el
presupuesto sigue siendo un fallo de CI, no una omisión ni un éxito simulado.

Las PR #432 y #433 expusieron otro punto anterior al encendido de Wi-Fi: la
consulta de `ro.kernel.qemu` podía devolver `error: closed` (salida 1) o una
salida 255 sin texto tras el arranque. No se había instalado la app ni iniciado
la instrumentación. La verificación del serial seleccionado ahora tiene un
presupuesto de 30 segundos para esas desconexiones, con cada consulta limitada
a cinco segundos. Una respuesta correcta que no sea `1`, falta de autorización
o un error de permisos se rechaza de inmediato. Se usa tanto en integración
como en la aceptación de la APK de release; ninguna prueba se reintenta.

## Silencio en Live después de recuperar WHEP

Buscar `LiveTestDiagnostics` en el logcat de `LiveListenerTest` o del shard.
Las observaciones JSON incluyen tiempo monótono, fases, cierre de Activity,
estado de MediaSession, PCM generado/decodificado/audible y antigüedad del
último bloque audible. Las muestras periódicas se toman también durante los
`await`, antes de que el `finally` cierre los peers.

- `peer.start`, `peer.state`, `ice.state`, `peer.cancel`, `peer.close`: cada
  peer tiene un identificador local y `publishing` distingue emisor y receptor.
- `listener.gain`, `listener.focus`, `track.bound`, `track.volume`: relacionan
  petición de reproducción, foco, supresión, volumen y ganancia aplicada.
- `rtc.stats`: paquetes/bytes, pérdidas, jitter, energía de audio, muestras
  ocultadas por el decodificador y latencia del par ICE seleccionado.
- `relay.stats`: contadores RTP de entrada/salida por publisher/reader del
  relay real, limitados a la sala de esta prueba.

Comparar **incrementos** entre muestras. Si avanza la fuente sintética pero no
los paquetes del emisor, investigar la captura/codificación. Si el emisor
envía pero el relay no recibe, investigar el transporte hacia el relay. Si el
relay recibe pero no entrega al reader, investigar el relay. Si llegan RTP
al receptor y crecen `concealedSamples`/`silentConcealedSamples`, investigar
pérdidas, jitter y decodificación; callbacks de PCM con RMS cero no prueban
que hayan llegado paquetes de audio. Si los contadores y la energía son
normales, contrastar la ganancia aplicada y el foco con la fase exacta.

## RTP detenido con ICE conectado

El gate del tag de la PR #433 registró ocho paquetes RTP en el receptor durante
veinte segundos, con ICE conectado, consultas STUN activas y callbacks de
concealment/silencio. El relay seguía procesando media; ese contador no prueba
entrega de datagramas. No se demostró que cerrar la Activity causara la pérdida.
El timeout del reset del fixture ocurrió en el primer caso, varios minutos antes,
y queda como incidente separado, sin atribuirle una causa común.

El listener ahora observa progreso RTP mientras se solicita reproducción sin
supresión de foco. Da diez segundos al inicio y recupera cinco segundos sin
progreso después de recibir media. No usa amplitud PCM: el silencio legítimo
sigue sano si llegan paquetes. Reutiliza el presupuesto acotado de reconexión;
ICE conectado ya no lo reinicia hasta observar cinco segundos de progreso
sostenido. Pausa/supresión rearman la gracia y no hacen consultas de estadísticas.
Si el mismo transporte se reconecta durante el backoff, se cancela únicamente
el reinicio pendiente: el presupuesto y su plazo original siguen activos hasta
confirmar media sostenida. La revisión de Codex detectó este caso y se cubre con
regresiones de reloj simulado para cancelación, plazo y backoff conservados.

La regresión nativa detiene las codificaciones RTP del emisor sintético, conserva
ICE y sockets de sala, exige BUFFERING y comprueba recuperación automática de
RTP/audio conservando volumen, intención de reproducir e identidad de sala.
También exige paquetes reales después de cerrar la Activity: el concealment por
sí solo ya no puede satisfacer ese guard. Esto repara la falta de recuperación
ante media detenida; no identifica la causa original de pérdida de datagramas.

La observación se activa sólo cuando la instrumentación instala su observer.
No exporta PCM, SDP, URLs, tokens, cookies, candidatos ICE ni direcciones IP.
`sample.failed`/`rtc.stats.unavailable` indican un hueco de diagnóstico, nunca
un permiso para dar la prueba por aprobada.

## Incidente del 2026-11-03

Run `41548539741`, intento inicial, main `9986f87b`: sólo falló el shard 6,
`LiveListenerTest.tlsCoreRelay`, con `Activity close stopped remote programme`.
Al fallar: READY, reproducción solicitada/activa, volumen 0.4, 2794 callbacks
PCM, 129 audibles, 3055 lecturas de la fuente sintética y RMS cero. El relay
conservó publisher y reader hasta la limpieza. Sin RTP, energía ni cronología
de ganancia no se puede atribuir ese silencio al cierre de Activity ni decidir
si el origen era aplicación, relay o emulador. Un reintento aprobado demuestra
intermitencia, no una causa resuelta. No se relajan las aserciones.

## Diagnóstico del traspaso remoto

En la PR #434, run `42567024132`, el shard 7 ejecutó 33 casos y falló
`QueueLanesTest.httpQueueLanesAndResume`: el portátil recibió la orden de parar,
pero el snapshot nativo del teléfono seguía con cola vacía después de aceptar
Resume. Esto es distinto de los shards 1 y 5, que no llegaron a instrumentación
porque la descarga de MediaMTX agotó seis intentos HTTP 504.

El shard 3 del siguiente head falló en la misma descarga antes de instrumentar.
Los seis intentos alternan ahora la URL de descarga y la API oficial del mismo
asset inmutable de GitHub, con `Accept: application/octet-stream`. Ambas vías
exigen el mismo SHA-256 y límite de tamaño. Se verificó una descarga real por
la API contra el hash fijado; recibir JSON o bytes distintos sigue fallando.

El HTTP exitoso de handoff no confirma que el teléfono haya aplicado el comando.
Las trazas deben distinguir registro de socket, entrega al cliente, rechazo de
propietario/generación y excepción al reconstruir la cola. Se conservan las
aserciones y los plazos del caso; un reintento verde por sí solo no demuestra
que se haya reparado la causa.
