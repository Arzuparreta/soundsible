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
