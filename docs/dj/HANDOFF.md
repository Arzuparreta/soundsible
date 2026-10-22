# Traspaso: revisión del modo DJ

Punto de entrada para revisar y mejorar el modo DJ punto por punto, en sesiones
nuevas y sin el historial del chat. Estado del código revisado: `main` en
`f1e79d30`. Los números de línea se refieren a ese commit; si el código ha
cambiado, buscar por nombre de función.

El documento empezó como diagnóstico. Los puntos cerrados lo indican en la tabla
de estado y en su sección; el resto sigue siendo diagnóstico.

## Cómo trabajar con este documento

- Revisar **un punto por sesión** (o los que el usuario indique). Al cerrar uno,
  actualizar su fila en la tabla de estado y su sección, con el commit o PR.
- Respetar `AGENTS.md`: rama + PR, etiqueta `impact:*`, esperar CI, no merge sin
  permiso del usuario, no `npm run build`, suite completa de Playwright si se toca
  `ui_web/`.
- Cualquier cambio en el análisis de `shared/dj_engine.py` debe subir
  `ANALYSER_VERSION`: la caché `cache/dj/analysis.sqlite3` está indexada por esa
  versión y las medidas antiguas no se invalidan de otro modo.
- Decisiones del usuario que siguen vigentes:
  - La mezcla es automática: no hay selector de estilo ni de "booth" por diseño
    (eliminado en `ae161f0`). Solo existe el interruptor **Ajustes → DJ →
    Mezclar entre canciones**.
  - La nivelación de volumen es una ganancia constante por canción: nunca cambiar
    el volumen de una canción mientras suena.
  - Android debe igualar las funciones de la web, con la mejor implementación
    nativa, no copiar soluciones provisionales de la web. La lógica del DJ está
    en el servidor; Android solo ejecuta la mezcla. Una diferencia de interfaz
    con la web solo se acepta si la impone el port, y si un cambio rompe
    Android se arregla en la misma PR (2026-10-22).
- Decisiones del 2026-10-22 (ver *Decisiones de diseño* más abajo):
  - Se elimina el arco de energía. El DJ no dirige la sesión: la dirigen las
    fuentes y el recomendador. El DJ ordena para que las transiciones sean
    buenas y mezcla.
  - Ningún valor de gusto escrito a mano y ninguna nota humana (ni del usuario
    ni del asistente) para calibrar medidas. El código mide magnitudes con
    unidad, comprobables con señales sintéticas de respuesta conocida.
  - El DJ debe tener más música analizada de la que hoy le llega, y puede
    añadir canciones puente al pool, **siempre que se elimine o se mitigue al
    máximo la preferencia circular** por las canciones ya descargadas
    (condición del usuario).
- Comunicar en español, claro y literal.

## Síntoma que el usuario oye

Antes de #377: las transiciones solían caer en el sitio correcto, pero con unos
milisegundos de desfase: cuando los kicks de las dos canciones coincidían en el
pulso 1, se oía el kick de una y muy poco después el de la otra (efecto "flam").
La causa medida estaba en P1.

Después de #377 el usuario (músico) no oye ningún desfase. P2 queda aparcado:
no hay síntoma que lo justifique.

## Estado

| Punto | Tema | Evidencia | Estado |
| --- | --- | --- | --- |
| P1 | Precisión del tempo y de la rejilla de golpes | Medido | Cerrado (#377) |
| P2 | Alineación de fase en el navegador | Lectura de código | Sin síntoma tras #377; se retoma solo si vuelve a oírse desfase |
| P3 | El orden de la ruta ignora la calidad de la transición | Lectura de código | Pendiente; diseño decidido (continuidad). El arco ya se quitó (#385): hoy el orden es el barajado |
| P4 | La "energía" no mide intensidad | Medido | Cerrado (#385): notas/s, LUFS y planitud; `energy` eliminado |
| P5 | Canciones de YouTube sin caché: fundido simple | Lectura de código | Pendiente; ampliado a pool analizado y puentes |
| P6 | Compatibilidad de tonalidad mal puntuada | Lectura de código | Pendiente |
| P7 | Perfiles de DJ y dirección sin efecto en la ruta | Lectura de código | Dirección y menú de estilos eliminados (#385); queda decidir la opción (b) en el servidor |
| P8 | Secciones medidas y no usadas | Lectura de código | Pendiente |
| P9 | Eco no sincronizado con el tempo | Lectura de código | Pendiente |
| P10 | Código muerto y documentación desactualizada | Lectura de código | En parte (#385): queda `automation` |

Orden acordado con el usuario (2026-10-22): **P4 rehecho → P6 → P3 → P5
ampliado**, después P8 y P9. P7 y P10 son decisiones y limpieza. P2 no se trabaja
salvo que vuelva el síntoma. P4 está cerrado: **el siguiente es P6**.

Por qué este orden: P3 ordena con las medidas de P4 y con la puntuación de
tonalidad de P6 (`plan_transition`: `0,46·tempo + 0,32·armonía + 0,22·confianza`),
así que va después de los dos. P5 amplía el pool que P3 ordena.

## Decisiones de diseño (2026-10-22)

### Sin arco de energía

El arco es `_auto_set_arc_position` (`auto_mode.py`): seis valores fijos
`(0.34, 0.52, 0.74, 0.9, 0.78, 0.58)` escritos a mano. El índice es (canciones
distintas oídas entre las 4 últimas + `segment_index`) mod 6; `segment_index` lo
sube el cliente en cada recarga (`ui_web/src/lib/generatedQueue.ts`,
`ProgramDjPlanner.kt`). Desde la cuarta canción avanza un paso por recarga, y las
8 canciones de una recarga buscan el mismo objetivo. La respuesta incluye
`"arc": {"target", "phase"}` y ningún cliente lo lee.

El usuario lo quita: no aporta nada que no haga ya el recomendador (con techno de
fiesta, la reproducción normal ya sigue dando techno de fiesta). Eliminados en
#385: `_auto_set_arc_position`, el orden por energía de
`_build_music_set_route`, la elección de la primera canción por energía y el
campo `arc` de la respuesta.

### Medir, no calibrar

Condición del usuario: si hay que escribir a mano un valor de gusto o poner notas
a canciones, no se implementa. Lo que vale:

- Magnitudes con unidad física: notas por segundo, LUFS, BPM, planitud espectral.
- Constantes de procesado de señal (ventanas, bandas, separación mínima entre
  ataques) fijadas para que señales sintéticas de respuesta conocida den el valor
  correcto, como las pistas de clics de P1.
- Escalas que salen de los datos de cada ruta (dispersión entre las candidatas
  del momento), no constantes globales.

No vale: notas de intensidad puestas por una persona, curvas o pesos ajustados
"para que salga bien", un único número de "energía" que mezcle ritmo, timbre y
volumen con pesos elegidos.

### Más música analizada, sin preferencia circular

Hoy solo se analiza lo que ya está en disco (`_dj_source_path`): la biblioteca
local y las previews ya descargadas. Las related de YouTube sin descargar no
tienen BPM, tonalidad ni puntos de mezcla. El usuario quiere que el DJ tenga
localizada y analizada más música y que pueda añadirla al pool (canciones puente).

Antecedente: hasta `76113008` (2026-07-31) se descargaban por adelantado las
previews de todas las candidatas. Se quitó por dos razones, escritas en
`_dj_source_path`: era caro, y daba **ventaja circular** a las canciones ya
descargadas (analizadas → elegidas más → siguen descargadas). La condición del
usuario es eliminar o mitigar al máximo esa ventaja. Ver P5.

### Dirección y estilos: eliminados (2026-10-22)

Decisión del usuario: sin energía única, la dirección (`direction.energy`) se
quita; y Android debe ser igual que la web. El menú de estilos (4 perfiles) y el
diálogo de dirección los había añadido el port de Android (#300) al menú `⋯` de
`ProgramTransport.tsx`, dos meses después de que la web los quitara
(`ae161f0`): nadie lo había decidido. Se eliminan en los dos clientes, y la
dirección entera (energía, familiaridad, texto, incluir, excluir) en servidor,
web y Android, porque ya nada puede fijarla. Los dos clientes envían siempre
`dj_profile: "adaptive"` (`DJ_PROFILE` en `api.ts`, `ProgramDjPlanner.PROFILE`).
El servidor mantiene sus cuatro perfiles para la opción (b) de P7.

---

## Cómo funciona hoy

### Archivos

| Parte | Archivo |
| --- | --- |
| Análisis de audio y cálculo de cada transición | `shared/dj_engine.py` |
| Endpoints `dj-plan`, `dj-place`, `dj-repair`, `dj-transition` | `shared/api/routes/auto_mode.py` |
| Cuándo y cómo se lanza cada transición (navegador) | `ui_web/src/stores/dj.ts` |
| Ejecución de la mezcla con dos reproductores | `ui_web/src/lib/audio/mixer.ts` |
| Nodos de filtro y eco | `ui_web/src/lib/audio/graph.ts` |
| Android: pide los planes al mismo servidor y mezcla en nativo | `android/.../ProgramDjPlanner.kt`, `ProgramDjRefiner.kt`, `ProgramMixCurve.kt` |
| Documentación de usuario | `docs/AUTO_MODE.md` |

### Flujo

1. **Análisis** (`analyse_audio`). Solo se analizan archivos que ya están en disco:
   biblioteca local o caché de previews de YouTube. FFmpeg decodifica a mono,
   11025 Hz; NumPy calcula las medidas; solo se guardan las medidas en SQLite. En
   segundo plano, 2 hilos (`request_analysis`). Canciones de más de 8 minutos: solo
   los primeros 90 s y los últimos 120 s. Mientras no hay análisis se usa
   `_fallback()` con `confidence` 0,18.
2. **Candidatas** (`_build_music_set_route`, `auto_mode.py:1219`): canciones de cada
   fuente, más las "related" de YouTube Music (25 por semilla) de las últimas 4
   canciones de cada fuente, más las related de las últimas 4 canciones
   automáticas que llegaron a sonar ("exploration"). Se quitan excluidas, ya
   oídas y grabaciones de más de 20 minutos.
3. **Orden**: barajado con semilla fija por sesión y segmento; se cogen las 8
   primeras (ver P3). La primera canción de una sesión sin semilla es la de la
   fuente más reciente que sale primero en ese barajado.
4. **Transición de cada par** (`plan_transition`, `dj_engine.py:671`), con perfil
   `"adaptive"` fijo.
5. **Ejecución** en el navegador (`stores/dj.ts`, `mixer.ts`).

### Medidas por canción (`_compose`, `_window_features`)

| Campo | Cómo se calcula | ¿Se usa al planificar? |
| --- | --- | --- |
| `bpm` | Recta (o curva local) ajustada a todos los golpes de la ventana; ver P1 | Sí |
| `beat_grid` | Rejilla ajustada y alineada al inicio del ataque, 4 decimales; ver P1 | Sí |
| `downbeats` | De las 4 fases del compás, la de mayor cambio armónico y ataque más fuerte; asume 4/4 | Sí |
| `key`, `mode` | Perfiles Krumhansl sobre el croma del espectro medio | Sí |
| `note_rate` | Ataques por segundo de música que suena (P4) | No (lo usará P3) |
| `loudness_lufs` | Sonoridad integrada EBU R128 de FFmpeg, en la misma decodificación (P4) | No (lo usará P3) |
| `spectral_flatness` | Planitud espectral 100–5000 Hz de los fotogramas fuertes, ponderada por potencia (P4) | No (lo usará P3) |
| `intro_cue` | Primer instante con energía sobre el percentil 35 | Sí (punto de entrada) |
| `outro_cue` | Primer límite de frase unos 64 golpes antes del último sonido | Sí (punto de salida) |
| `sections` | Etiquetas intro/build/drop/breakdown/body/outro por bloques de 8 compases; `level` es el nivel medio frente al de la propia canción | No (P8) |
| `tempo_confidence` | Parte de golpes que encajan en la rejilla; ≤ 0,6 si el tempo deriva | Sí, dentro de `confidence` |
| `confidence` | `0,38 + 0,36·tempo_conf + min(0,2, margen_tonalidad/8)` | Sí |

### Cálculo de la transición (`plan_transition`)

```
ratio = bpm_sale / bpm_entra   (si < 0,7 se multiplica por 2; si > 1,4 se divide por 2)
tempo     = 1 − |1−ratio| / max_stretch_del_perfil
armonía   = misma tónica y modo 1.0 · misma tónica, otro modo 0.82 · 4ª/5ª 0.86 · 3ª/6ª 0.68 · resto 0.35 · sin tonalidad 0.55
confianza = mínimo de las dos canciones
score     = 0.46·tempo + 0.32·armonía + 0.22·confianza
```

| Perfil | Compases | Estiramiento máx. | score ≥ 0,72 | score ≥ 0,55 | conf ≥ 0,42 | resto |
| --- | --- | --- | --- | --- | --- | --- |
| `adaptive` | 16 | 8 % | bass_swap | filter_blend | structural_fade | safe_fade |
| `long_blend` | 32 | 6 % | long_blend | filter_blend | structural_fade | safe_fade |
| `cuts_drops` | 8 | 10 % | — | — | echo_cut | safe_fade |
| `open_format` | 8 | 12 % | bass_swap | filter_blend | echo_cut | safe_fade |

- Solapamiento: compases × duración del compás de la canción que sale, entre 4 y
  48 s. Las técnicas de corte o fundido se limitan a 8 compases.
- `out_cue` = `outro_cue` ajustado al downbeat más cercano. `in_cue` =
  `intro_cue` ajustado al downbeat más cercano.
- `playback_rate` = relación entre los periodos medidos cerca de cada punto. Solo
  en bass_swap, long_blend y filter_blend, y solo si el cambio es ≤ 6 %. Si no, 1,0.

### Ejecución en el navegador

`stores/dj.ts`:

- 65 s antes de `out_cue`: si la transición tiene `confidence < 0,35`, pide
  `dj-transition` **una sola vez** (solo lee la caché).
- 45 s antes de `out_cue`: carga la siguiente canción en el segundo reproductor
  (`armTransition`).
- Transición con `confidence < 0,35`: se convierte en `safe_fade` de 6 s como
  máximo, la canción entrante empieza en 0:00. En una canción de 4 minutos el
  fundido empieza unos 24 s antes del final.
- Transición fiable: solapamiento limitado al 25 % de la duración. La salida no
  empieza antes de 90 s o del 60 % de la canción, lo que llegue antes. Si
  `out_cue` cae fuera de esa ventana se mueve compases enteros (`placeOutCue` en
  `ui_web/src/lib/djCue.ts` y `ProgramDjPlan.placeOutCue` en Android), no una
  cantidad cualquiera.
- "Mezclar entre canciones" apagado: técnica `direct`, la siguiente empieza
  cuando termina el archivo.

`mixer.ts` y `graph.ts`:

- La canción entrante arranca en silencio hasta 4 s antes del punto de mezcla, a
  `playback_rate` (0,94–1,06, `preservesPitch` activado). Mientras está en
  silencio se corrige **una vez** su posición para que `in_cue` coincida con
  `out_cue`, con tolerancia de 5 ms.
- Volumen: curva de igual potencia (seno/coseno) durante el solapamiento,
  calculada con el reloj de la canción entrante. Umbral del limitador a −6 dB
  durante la mezcla.
- Al terminar, la velocidad de la entrante vuelve a 1,0 de forma lineal en 8 s.

| Técnica | Qué hace |
| --- | --- |
| `bass_swap` | Lowshelf de 220 Hz: la que sale baja de 0 a −18 dB y la que entra sube de −18 a 0 dB, en 6 pasos repartidos por todo el solapamiento |
| `filter_blend` | Paso bajo: la que sale baja de 22 kHz a 700 Hz; la que entra sube de 900 Hz a 22 kHz |
| `long_blend` | `bass_swap` y `filter_blend` a la vez |
| `echo_cut` | Retardo fijo de 0,28 s, realimentación 0,32, mezcla de eco hasta 0,32 sobre la que sale |
| `structural_fade`, `safe_fade` | Solo la curva de volumen; en el navegador son la misma operación |

---

## P1. Precisión del tempo y de la rejilla de golpes

**Qué pasa.** `_window_features` (`dj_engine.py:466`) usa `hop = 512` a 11025 Hz:
un paso equivale a 46,4 ms. El retardo de la autocorrelación es un número entero
de pasos, así que el BPM solo puede tomar valores separados por un 8–10 % cerca
de 120. `_snap_beat_frames` coloca cada golpe en un paso entero, así que cada
golpe puede estar desviado hasta unos 23 ms. `_local_period` (el periodo usado
para estirar el tempo) sale de esos mismos intervalos.

**Evidencia (medida).** `python -I docs/dj/bpm_probe.py` con pistas de clics:

| BPM real | `bpm` medido | Periodo local (BPM) | Intervalos de la rejilla (s) |
| --- | --- | --- | --- |
| 118 | 117,45 | 117,42 | 0,464 / 0,511 |
| 120 | 117,45 | 117,42 | 0,464 / 0,511 |
| 122 | 117,45 | 117,42 | 0,464 / 0,511 |
| 124 | 129,20 | 129,03 | 0,464 / 0,511 |
| 126 | 129,20 | 129,03 | 0,464 / 0,511 |
| 128 | 64,60 | 64,59 | 0,928 / 0,976 |
| 130 | 64,60 | 64,59 | 0,882 / 0,929 |
| 140 | 143,56 | 143,54 | 0,417 / 0,465 |
| 174 | 86,13 | 86,08 | 0,650 / 0,697 |

Leer la mitad del tempo (64,6 en vez de 128) no afecta a la mezcla porque la
relación se multiplica o divide por 2. Lo que afecta es el salto entre valores.

**Cuándo falla.**

- 120 contra 122 BPM: las dos miden 117,45, no se ajusta la velocidad, y en un
  bass_swap de 16 compases (unos 32 s) acaban desfasadas aproximadamente un golpe.
- 122 contra 124 BPM: 117,45 contra 129,2 (9 %). Se considera incompatible, no se
  estira, y el `score` de tempo es 0.
- Cualquier par: el punto de entrada y el de salida son golpes con hasta ~23 ms
  de error cada uno. Es el desfase de pocos milisegundos que oye el usuario.

Además, al medir con pistas sintéticas de golpes conocidos (codificadas en AAC,
como las previews) apareció otro error mayor: la rejilla quedaba unos 140 ms
**antes** de cada golpe, por la convención de tiempo del fotograma de 186 ms, y
ese sesgo variaba ±15 ms según el tipo de bombo. En algunas pistas se enganchaba
al contratiempo (+110 a +135 ms). Y los clientes recortaban `out_cue` a su
ventana permitida (`resolveTransition`, `ProgramDjPlan.resolve`) por una cantidad
cualquiera, lo que sacaba la entrada del compás cuando el corte llegaba a aplicarse.

**Estado: cerrado en #377.** `ANALYSER_VERSION` 4. Cambios:

- `shared/dj_engine.py`, sección *Rhythm*: un STFT propio (ventana 1024, paso 128
  = 11,6 ms) con flujo logarítmico en 24 bandas; tempo por autocorrelación con
  apoyo en 2 y 4 golpes y pico interpolado; seguidor de golpes por programación
  dinámica (Ellis 2007, vectorizado por bloques); ajuste de una recta por
  consenso de fase y mínimos cuadrados (`_phase_fit`), o curva local robusta
  (`_local_lines`) si la canción deriva; comprobación pulso/contratiempo con el
  nivel de energía; y alineación final de la rejilla al inicio del ataque
  (energía con preénfasis 0,95 en ventanas de 2 ms, media de muchos golpes).
- Decisión rejilla constante o local: mediana de la desviación de la curva local
  respecto a la recta ≤ 12 ms, tempo local dentro del 0,3 % del de la recta y
  ≥ 55 % del peso de los golpes sobre la recta. Coincide con la clasificación de
  la referencia en 47 de 53 canciones reales.
- `tempo_confidence` ya mide algo: parte de golpes que encajan en la rejilla; en
  rejilla local se multiplica por 0,7 (la mezcla mantiene una sola velocidad
  durante todo el solapamiento). Entra en `confidence` con la misma fórmula.
- `downbeats`: cambio de croma (dos golpes antes contra dos después) más fuerza
  del ataque. En las 17 canciones reales cuya rejilla coincide con la referencia,
  acierta en 9 (antes 4).
- `_local_period(analysis, cue, span)`: recta por los golpes del tramo que se
  mezcla, no mediana de intervalos redondeados.
- `plan_transition`: `out_cue` ≤ `duración − solapamiento − 1,5 s` (los clientes
  cortan a 1 s) y cues, tasa y periodos con más decimales.
- Clientes (paridad web/iPhone y Android): si tienen que mover un `out_cue`
  medido, lo mueven compases enteros (`sync.out_period × 4`). La web pasa ahora
  `sync.phase_tolerance_ms` al mezclador, como ya hacía Android.

**Resultados (medidos).**

- `python -I docs/dj/bpm_probe.py`: 118–140 BPM medidos con error ≤ 0,004 BPM y
  rejilla a ~1 ms de cada clic. 174 se sigue leyendo como 87 (mismo pulso).
- 18 pistas sintéticas en AAC con bombos de cinco formas: error de BPM ≤ 0,002 %
  y rejilla a ±0,7 ms del ataque en las de tempo fijo; compás correcto en 16.
  Parejas mezclables (100): desfase al inicio de la mezcla, mediana 0,8 ms (antes
  49,6 ms); máximo durante el solapamiento, mediana 1,0 ms (antes 237 ms).
- 53 previews reales contra beat_this (referencia externa, solo para evaluar):
  rejilla en el pulso en 19 (antes 8), tempo distinto en 11 (antes 25, sobre todo
  por los saltos de valores).
- `tests/test_dj_beat_grid.py` fija estos umbrales con canciones sintéticas.
- Coste: ver `docs/PERFORMANCE.md`, *Beat grid analyser*. Un solo hilo, sin
  aumento de memoria pico.

**Límites que quedan (medidos).**

- Salsa y otros estilos donde el bajo y la percusión acentúan el contratiempo: la
  rejilla puede quedar a medio golpe de donde lo marca un oyente. Dos canciones
  así se mezclan bien entre sí; con una de rejilla en el pulso, no.
- Rock en directo con sensación ternaria: a veces se mide 3:2 o 4:3 del tempo de
  referencia.
- Breakbeat a 174 BPM con bombo sincopado: se lee a 87 y la rejilla puede caer en
  los contratiempos (caso sintético 12).
- Una canción que deriva mantiene la rejilla local, pero la mezcla usa una sola
  velocidad: el desfase crece durante el solapamiento (P2).
- La regla del ataque marca unos 3 ms dentro de un ataque lento (6 ms) cuando no
  hay ningún transitorio en el pulso; con clic, en el clic.

## P2. Alineación de fase en el navegador

**Estado: sin síntoma.** Tras #377 el usuario no oye desfase en las mezclas. Lo
que sigue es diagnóstico por lectura de código, sin medir; se retoma solo si
vuelve a oírse un desfase entre los golpes de las dos canciones.

**Qué pasa.** `mixer.ts` (`tick`, fase `prerolling`) mueve `currentTime` del
`<audio>` entrante una sola vez, mientras está en silencio, con un temporizador
de 40 ms (`TICK_MS`). Después no hay más corrección: si los tempos no coinciden
exactamente, el desfase crece durante todo el solapamiento. `bass_swap` mantiene
los graves de las dos canciones audibles durante buena parte de la mezcla (−4 y
−12 dB en la que sale), así que cualquier desfase se oye.

**Evidencia.** Lectura de código. No se ha medido el error de `currentTime` en
cada navegador.

**Android es distinto.** `ProgramMixOutput.kt` mezcla las dos canciones en una
sola salida y `ProgramMixPlayer.kt` programa el inicio de la mezcla en muestras
de esa salida; la velocidad se aplica con `PlaybackParameters` en
`ProgramDjSession.kt`. Este punto afecta sobre todo a la web. P1 afecta a las
dos plataformas, porque los puntos de entrada y salida vienen del mismo servidor.
No se ha medido el desfase en Android.

**iPhone.** La app nativa de iOS no tiene modo DJ (`ios/App/Audio/DualDeckPlayer.swift`
solo hace crossfade). El DJ en iPhone es la web en Safari, así que este punto le
afecta igual que a cualquier navegador.

**Cuándo falla.** En cada mezcla con beatmatch. Tras P1 los puntos y la velocidad
llegan con error de ~1 ms y 1e-6; lo que queda en la web es la precisión de
`currentTime` en la alineación única y la deriva de canciones con tempo variable.

**Android, por verificar (no medido).** `ProgramDjSession.advance` carga la
entrante con `setMediaItem(item, positionMs)` y `ProgramMixOutput.arm` consume
`prerollMs` de su PCM suponiendo que empieza exactamente en esa posición
(`streams[standby].positionOffsetUs`). Si el decodificador empieza en el límite de
un fotograma AAC (1024 muestras = 23 ms a 44,1 kHz) y no en la posición pedida, la
entrante llegaría hasta 23 ms adelantada o retrasada. Se puede comprobar con el
`presentationTimeUs` del primer `write()` tras el seek en `ProgramMixOutput.Source`.

**Posibles soluciones.**

- Corregir la deriva durante toda la mezcla: comparar periódicamente la posición
  esperada de la entrante con la real y ajustar `playbackRate` en pequeños pasos,
  en vez de un único salto.
- A más largo plazo: reproducir las dos canciones como `AudioBuffer` /
  `AudioWorklet` y programarlas con `AudioContext.currentTime` para obtener
  precisión de muestra. Coste: decodificar en memoria (contrasta con la política
  de no retener audio en RAM) y cambios grandes en `graph.ts`.
- Medir antes: instrumentar el error de fase (posición entrante esperada contra
  real) en `recordPlaybackDiagnostic` para tener números por dispositivo,
  especialmente en el iPhone (WebKit).

## P3. El orden de la ruta ignora la calidad de la transición

**Qué pasa (desde #385).** En la ruta v6 (`_build_music_set_route`, la que usa
siempre la web porque envía `sources`, y Android cuando tiene fuentes):

1. `rng.shuffle(available)`, con semilla por sesión y segmento.
2. Se cogen las 8 primeras y se calcula la transición de cada par.

El arco de energía (`_auto_set_arc_position`, el orden por energía, la elección
de la primera canción por energía y el campo `arc` de la respuesta) se eliminó
en #385; el test que lo fijaba también. No cuentan: la calidad de la
transición, `score`, `semantic_score` ni el peso de la fuente
(`weight = 0.38 + 0.62·…`; solo se usa para elegir la primera canción).

`order_route` (`dj_engine.py:767`) sí ordena con `0,42·transición + 0,38·semántica
+ 0,20·relevancia`, pero solo se usa en la ruta antigua sin `sources` (Android
sin fuentes), en Fix mix (`dj-repair`) y al colocar canciones (`dj-place`).

**Cuándo falla.** En cada recarga de la ruta. Dos canciones seguidas pueden ser
incompatibles en tempo o tonalidad aunque haya candidatas compatibles en el pool.
`docs/ARCHITECTURE.md`, `docs/PLAYBACK_QUEUE_CONTRACT.md` y `README.md` ya no
dicen "recency decay" ni "orders songs by tempo, key and energy" (#385).

**Diseño decidido (2026-10-22).**

- Sin arco (hecho en #385).
- La ruta v6 ordena por calidad de transición (`order_route` o su lógica) y por
  **continuidad**: la siguiente canción cerca de la actual en cada magnitud de P4
  (notas/s, LUFS, timbre, tempo). Cada magnitud se escala por su dispersión
  entre las candidatas de esa ruta; pesan igual tras escalarlas. No hay pesos
  ajustados a gusto.
- Mantener el peso de la fuente donde ya cuenta (elegir la primera canción).
- `test_dj_plan_v6_does_not_steer_by_energy` fija que hoy el orden no depende
  del análisis; P3 lo cambiará a propósito.
- Las magnitudes están en el análisis: `note_rate`, `loudness_lufs`,
  `spectral_flatness`, `bpm`. `loudness_lufs` puede ser `None` (silencio o
  menos de 400 ms); `note_rate` y `spectral_flatness` son 0 en silencio. Una
  canción sin analizar no tiene ninguna (P5: no puntuarla peor por eso).

## P4. La "energía" no mide intensidad

**Qué pasa (en `main`).** `energy = rms / percentil95(rms)` dentro de la misma
canción (`_window_features`), y se guarda la media (`_compose`). Mide lo uniforme
que es el nivel de la canción, no lo intensa que es. Normalizar cada canción
contra sí misma hace que los valores no se puedan comparar entre canciones, que
es justo lo que necesita la ruta.

**Primer intento descartado: #384 (rama `fix/dj-energy-intensity`).** Cambiaba
`energy` por la planitud espectral de los fotogramas fuertes en escala
logarítmica (0,002 → 0, 0,25 → 1). Se validó contra notas de intensidad de 1 a 5
que puso el asistente a 75 canciones de la biblioteca del usuario: Spearman 0,84
contra 0,23 de la medida antigua. El usuario lo rechazó, con razón:

- La planitud mide **timbre** (ruido o tonos limpios), no actividad musical.
  "Little" Fugue de Bach para cuarteto de flautas de pico (rápida, contrapunto
  denso) da 0,03, casi igual que el Agnus Dei de Barber por VOCES8 (legato,
  acordes largos), que da 0,00: planitud 0,0023 contra 0,0017. Mozart 25 y el
  preludio del acto 3 de Lohengrin también quedaban bajos.
- Las notas las puso el asistente, casi todas de pop, rock y electrónica, donde
  intensidad y distorsión van juntas. El 0,84 global escondía que la clásica
  fallaba entera.
- La escala 0,002 → 0, 0,25 → 1 era un valor elegido a mano.
- El detector de "ataques por segundo" del prototipo estaba mal: daba 8,9/s al
  Agnus Dei y 8,1/s a la fuga, porque contaba vibrato, reverberación y ruido, no
  notas. Por eso parecía que el ritmo no aportaba nada.

**Antes de empezar.** El servicio del usuario (`soundsible.service`) se reinició
el 2026-10-22 a las 15:04 con el repositorio en la rama de #384 y escribió
análisis con `ANALYSER_VERSION` 5 en `~/.cache/soundsible/dj/analysis.sqlite3`.
**El P4 rehecho debe usar `ANALYSER_VERSION` 6**, para que esas filas de la
planitud no se lean como válidas. #384 está en borrador y no se fusiona.

**Diseño decidido (2026-10-22).** No calcular una "energía" única. Medir por
canción magnitudes con unidad, cada una comprobada con señales sintéticas de
respuesta conocida:

| Magnitud | Unidad | Comprobación sintética |
| --- | --- | --- |
| Densidad de notas (ataques reales) | notas/s | Pistas con N notas/s conocidas, en legato y en staccato, con y sin reverberación y vibrato |
| Sonoridad integrada | LUFS | Ya existe `shared/loudness/measure.py` (EBU R128); los planes ya llevan `loudness_lufs` (`_annotate_plan_loudness`). Decidir si se reutiliza esa medida o se calcula en el análisis del DJ |
| Timbre: planitud espectral | 0–1 | Tono puro contra ruido; el cálculo por bloques de #384 en `_spectral_features` se puede reutilizar, sin la escala a 0–1 |
| Tempo | BPM | Ya existe (P1) |

Criterio de aceptación mínimo: la fuga de Bach para flautas de pico debe medir
muchas más notas por segundo que el Agnus Dei de Barber. Comprobarlo también con
música real de la biblioteca (`/mnt/storage/ARSU/music/library.json`,
`tracks/<id>.<format>`) sin poner notas: solo comparar magnitudes medidas con lo
que se sabe de la partitura (tempo y figuración).

Qué se aprovecha de #384: el cálculo de planitud por bloques y su test de
equivalencia (`tests/test_dj_spectral_memory.py`), la forma de los tests
sintéticos (`tests/test_dj_energy.py`) y el benchmark (`docs/PERFORMANCE.md`,
`scripts/benchmark_dj_analysis.py --allow-changes`). Qué no: la escala a 0–1, la
elección de la primera canción por energía y los cambios de `energy or 0.5`
(dejan de tener sentido sin energía única).

**Estado: cerrado en #385.** `ANALYSER_VERSION` 6. `energy` y `loudness_db`
desaparecen del análisis; en su lugar:

- `note_rate` (notas/s). `_note_onsets` en `shared/dj_engine.py`, sección
  *Notes*: flujo espectral al estilo SuperFlux (Böck y Widmer, 2013). Ventana
  de 512 muestras (46 ms) y paso 128 (11,6 ms) a 11025 Hz; bandas de un cuarto
  de tono de 40 Hz a 5 kHz (por debajo de ~400 Hz cada bin es una banda);
  logaritmo con suelo −60 dB del nivel fuerte; media de 3 fotogramas; cada
  banda contra el máximo de sus vecinas 2 fotogramas antes (anula el vibrato);
  a cada banda se le resta su propia fluctuación (mediana del cambio en bloques
  de 3 s), para que el ruido no cuente. Picos: máximo local ±30 ms, 2 por
  encima de la media de −50 a +70 ms, 60 ms entre ataques. Se cuenta sobre los
  segundos a menos de 20 dB del nivel fuerte, con silencios de hasta 1 s
  incluidos (los silencios de una pieza son música). Memoria acotada a bloques
  de 256 fotogramas.
- `loudness_lufs`: el medidor `ebur128` de FFmpeg en la misma decodificación
  (`_decode_measured`, una rama del `asplit` acaba en `anullsink`). Mide los
  canales y la frecuencia originales, igual que `shared/loudness` (mismo valor
  que el almacén de nivelación para la misma canción) y también sirve para las
  previews, que el almacén no mide. El PCM sale idéntico byte a byte a una
  decodificación sin medidor (test). Canciones de más de 8 min: suma en
  potencia de las dos ventanas medidas (90 s + 120 s). Coste: +0,2 s de CPU en
  una canción de 8 min.
- `spectral_flatness`: media geométrica entre aritmética de la potencia, 100–
  5000 Hz, en los fotogramas a menos de 20 dB del nivel fuerte, ponderada por su
  potencia. Sin escala: 0 para un tono puro, e^−γ ≈ 0,56 para ruido blanco.

Las constantes del detector se eligieron solo con señales sintéticas de
respuesta conocida (`tests/test_dj_note_rate.py`), con una búsqueda en rejilla
sobre 63 señales. La música real se midió después, sin notas puestas por nadie.

**Resultados sintéticos (medidos, en los tests).** Melodías de 1, 2, 4, 8 y 12
notas/s, ligadas y picadas, con y sin vibrato de 50 cents y reverberación de
sala (RT60 2 s, reverberación 6 dB por debajo del directo): todas dentro de
±25 %. Acordes de cuatro voces repetidos de 2 a 8 veces/s con caídas de 12 dB:
±25 %. Coro sostenido que cambia de acorde 0,25–1 vez/s: ±0,3. Batería: ±25 %.
Ruido blanco: < 1 nota/s (0,6). Tono fijo: 0. Nivel ×0,02: mismo valor ±5 %.

**Resultados reales (medidos, `analyse_audio` completo con FFmpeg).**

| Grabación | notas/s | LUFS | planitud |
| --- | ---: | ---: | ---: |
| Bach, «Little» Fugue BWV 578, flautas de pico graves | 5,00 | −14,5 | 0,0023 |
| Barber, Agnus Dei, VOCES8 | 0,42 | −14,7 | 0,0017 |
| Lumen Valo, Aestimatus sum (canto) | 0,79 | −31,5 | 0,0013 |
| Mozart, Concierto K. 488, II. Adagio | 1,46 | −25,8 | 0,0028 |
| Wagner, Lohengrin, preludio del acto 3 | 1,53 | −13,0 | 0,0502 |
| Mozart, Sinfonía 25, I. Allegro con brio | 2,46 | −20,9 | 0,0162 |
| Bach, Concierto BWV 1052, I. Allegro (clave) | 4,80 | −25,7 | 0,0229 |
| Radiohead, Everything In Its Right Place | 2,53 | −9,4 | 0,0144 |
| Soundgarden, Black Hole Sun | 2,75 | −7,9 | 0,1200 |
| Oliver Heldens, Ruins | 4,32 | −7,0 | 0,1050 |
| Sonora Ponceña, Fuego en el 23 | 5,20 | −9,7 | 0,0421 |
| Skrillex, Smoke | 7,56 | −6,0 | 0,1490 |

Criterio de aceptación cumplido: la fuga mide 12 veces más notas por segundo
que el Agnus Dei (con #384 la planitud de las dos era casi igual). La fuga va
en semicorcheas a unas 75 negras por minuto (≈ 5 notas/s): coincide.

**Límites que quedan (medidos).**

- Acordes repetidos en la misma nota con caídas de solo 6 dB y una sala que
  rellena el hueco: se cuenta ~40 % de los golpes (test
  `test_shallow_repeated_strokes_are_undercounted_but_still_ordered`). Es lo
  que pasa con los tresillos del preludio de Lohengrin (1,53 frente a ~6 de la
  partitura) y en parte con la Sinfonía 25 de Mozart. Siguen ordenadas: más
  golpes miden más.
- Ligado rápido (12 notas/s) en una catedral (reverberación al nivel del
  directo): ~45 %. Con la sala del test (−6 dB), dentro de ±25 %.
- Ruido blanco puro da 0,6 notas/s.
- La planitud mide timbre (ruido o tonos limpios), no actividad: es una
  magnitud de continuidad para P3, no una intensidad.

## P5. Canciones de YouTube sin caché: fundido simple

**Qué pasa.**

- Al planificar, `_dj_item_analysis(..., schedule=True)` solo encarga el análisis
  si el archivo ya existe (`_dj_source_path`). Para una preview que aún no se ha
  descargado no encarga nada.
- El navegador descarga la preview por adelantado, pero esa descarga no encarga
  análisis.
- El único que lo encarga es `dj-transition`, 65 s antes del corte, en la misma
  llamada que responde `measured: false`.
- `maybeRefineTransition` marca el par en `refinedPair` (`dj.ts:321`) antes de
  preguntar y no vuelve a preguntar.

**Evidencia.** Lectura de código. No se ha medido en reproducción real cuántas
transiciones acaban así.

**Cuándo falla.** En la primera transición hacia una canción de YouTube que no
estaba en caché: queda `safe_fade` de 6 s, entrada en 0:00.

**Posibles soluciones.** Encargar el análisis cuando el servidor termina de
guardar la preview en caché. Repetir el refinado hasta que haya medida o hasta el
momento de cargar la siguiente canción (45 s antes). Aplicar lo mismo en
`ProgramDjRefiner.kt`.

**Ampliado (2026-10-22): pool analizado y canciones puente.**

1. **Medir primero.** Añadir al registro de `dj-plan` cuántas candidatas tenían
   análisis en cada recarga. El campo `cache_hit` del registro actual cuenta la
   caché de related, no la de análisis. Medir cuánto cuesta descargar y analizar
   las previews de una recarga típica (en los registros hay entre 17 y 46
   candidatas únicas por recarga; una preview ocupa unos 3 MB; el análisis tarda
   0,1–0,3 s de CPU por canción).
2. **Analizar antes de elegir.** Descargar y analizar en segundo plano las
   previews de un número acotado de candidatas, elegidas por la puntuación de
   recomendación o por la semilla de la sesión, **nunca por estar ya en caché**.
3. **Biblioteca local entera analizada** en segundo plano. Es barato: 221
   canciones de menos de 8 minutos en 25 s con 8 procesos.
4. **Canciones puente.** Si la siguiente canción mezcla mal con la actual, meter
   entre las dos una canción analizada compatible con ambas. El usuario lo
   acepta. Ya hay puentes en `dj-place` (`_dj_place_bridge_pool`) y en
   `dj-repair` (`route_kind == "bridge"`); la ruta v6 no los usa.

**Condición: sin preferencia circular.** Lo que decide si una canción entra en la
ruta no puede ser que ya esté descargada o analizada. Ideas para cumplirlo:
elegir el conjunto que se analiza antes de mirar la caché; no puntuar a una
canción sin analizar como peor que una analizada (o no elegir hasta que todo el
conjunto esté medido); y comprobarlo con un test que compare dos pools idénticos
salvo en el estado de la caché.

## P6. Compatibilidad de tonalidad mal puntuada

**Qué pasa.** `_harmonic_score` (`dj_engine.py:619`) solo mira la distancia entre
tónicas y usa el modo solo cuando la distancia es 0:

- La menor relativa (La menor ↔ Do mayor, distancia 3): 0,68. En la rueda Camelot
  es la combinación más compatible después de la idéntica.
- Do mayor ↔ Do menor (paralela): 0,82. En Camelot está a 3 posiciones.
- Quinta con distinto modo (Do mayor ↔ Sol menor): 0,86.

La detección (`_window_features`) usa el espectro medio de toda la canción sin
compensar armónicos, con bins de 5,4 Hz, que no separan semitonos por debajo de
~130 Hz. Esto último no se ha medido.

**Posibles soluciones.** Puntuar con la rueda Camelot (misma posición, ±1, cambio
relativo mayor/menor). Mejorar el croma (pesos por armónicos, ignorar graves
ambiguos, o croma por tramos). Medir con canciones de tonalidad conocida antes y
después.

## P7. Perfiles de DJ y dirección sin efecto en la ruta

**Hecho en #385 (decisión del usuario, 2026-10-22: Android igual que la web).**

- La dirección se eliminó entera: `direction` en `dj-plan` (la ruta antigua ya
  no lee energía, familiaridad, incluir ni excluir; una petición antigua que la
  envía obtiene la misma ruta, test
  `test_dj_plan_ignores_the_direction_older_clients_still_send`), el endpoint
  `dj-command`, `api.interpretDjCommand`, `lib/djDirection.ts`,
  `mobile/DjDirection.tsx`, `setAutoDirection`, el estado `direction` de la web
  y de Android y su paso por las sesiones entre dispositivos (una sesión antigua
  que la trae se lee sin ella).
- El menú de 4 estilos del `⋯` de Android (`ProgramTransport.tsx`) se quitó. El
  menú DJ de Android ofrece lo mismo que la web: fuentes y Fix mix.
- Web y Android envían siempre `dj_profile: "adaptive"`: se quitaron
  `localStorage` `auto:dj-profile`, `setAutoDjProfile`, el perfil del estado de
  Android (`ProgramDjPlanner.profile`, `djProfile` de `PlaybackService` y de
  `PlaybackPlugin`) y su validación en `ProgramDeviceState`.

**Queda (necesita decisión del usuario).** El servidor conserva los cuatro
perfiles (`DJ_PROFILES`, `_PROFILE_POLICY`). Con `adaptive` nunca salen
`echo_cut` ni `long_blend`. Opción (b): que el planificador elija la técnica por
par sin perfiles, permitiendo también `echo_cut` y `long_blend` cuando el
material lo pida (por ejemplo, echo_cut si el tempo no encaja pero la confianza
es alta). Encaja con "la mezcla es automática". Si se descarta, quitar los
perfiles del servidor y el parámetro `dj_profile`.

## P8. Secciones medidas y no usadas

**Qué pasa.** `_sections_from_features` etiqueta bloques de 8 compases (intro,
build, drop, breakdown, body, outro), pero nadie lee las etiquetas. `outro_cue`
solo usa los límites de frase; `intro_cue` es el primer instante con sonido.
`loudness_db` se eliminó en P4 (lo sustituye `loudness_lufs`); `tempo_confidence` solo entra en `confidence`.

**Posibles soluciones.** Colocar la salida al inicio de un outro o antes de un
breakdown, y la entrada de forma que el drop de la entrante caiga en un límite de
frase de la que sale. Usar `tempo_confidence` para decidir si se intenta un
beatmatch: desde P1 vale ≥ 0,9 en canciones de tempo fijo y ≤ 0,6 en las que
derivan, pero hoy solo entra en `confidence` y casi no cambia la técnica elegida.

## P9. Eco no sincronizado con el tempo

**Qué pasa.** `ensureEcho` (`graph.ts:320`) usa `delayTime = 0.28` s fijo y
realimentación 0,32 con cualquier BPM. Android repite la curva en
`ProgramMixCurve.kt`.

**Posibles soluciones.** Pasar el periodo del golpe en el plan y usar un retardo
de 1/2, 3/4 o 1 golpe. Hoy `echo_cut` no sale nunca en la web (P7), así que este
punto depende de esa decisión.

## P10. Código muerto y documentación desactualizada

Hecho en #385: `api.interpretDjCommand`, `/api/discovery/music/dj-command`,
`_dj_command_direction`, `setAutoDjProfile`, `setAutoDirection`,
`setAutoProfile` (sin llamadores; además pedía claves `autoMode.note.crate.*`
que no existían), 76 claves de texto de `autoMode` sin uso en los cuatro
idiomas, "DJ style" en `docs/AUTO_MODE.md`, "recency decay" y "energy arc" en
`docs/ARCHITECTURE.md` y `docs/PLAYBACK_QUEUE_CONTRACT.md`, y el "orders songs by
tempo, key and energy" de `README.md`.

Queda: el campo `automation` que devuelve `plan_transition` no lo lee el
mezclador web ni el de Android (los dos deciden por `technique`). Quitarlo con
la decisión de P7 (b), que puede cambiar qué técnicas salen.
