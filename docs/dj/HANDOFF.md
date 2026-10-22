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
    nativa, no copiar soluciones provisionales de la web.
- Comunicar en español, claro y literal.

## Síntoma que el usuario oye

Las transiciones suelen caer en el sitio correcto, pero con unos milisegundos de
desfase: cuando los kicks de las dos canciones coinciden en el pulso 1, se oye el
kick de una y muy poco después el de la otra (efecto "flam"). Las causas
encontradas están en P1 y P2.

## Estado

| Punto | Tema | Evidencia | Estado |
| --- | --- | --- | --- |
| P1 | Precisión del tempo y de la rejilla de golpes | Medido | Cerrado (#377) |
| P2 | Alineación de fase en el navegador | Lectura de código | Pendiente |
| P3 | El orden de la ruta ignora la calidad de la transición | Lectura de código | Pendiente |
| P4 | La "energía" no mide intensidad | Medido | Cerrado (este PR) |
| P5 | Canciones de YouTube sin caché: fundido simple | Lectura de código | Pendiente |
| P6 | Compatibilidad de tonalidad mal puntuada | Lectura de código | Pendiente |
| P7 | Perfiles de DJ y dirección sin efecto en la ruta | Lectura de código | Pendiente (necesita decisión) |
| P8 | Secciones medidas y no usadas | Lectura de código | Pendiente |
| P9 | Eco no sincronizado con el tempo | Lectura de código | Pendiente |
| P10 | Código muerto y documentación desactualizada | Lectura de código | Pendiente |

Orden recomendado: P1 → P2 (el síntoma), después P5 y P3 (más mezclas reales y
mejor orden), después P4, P6, P8, P9. P7 y P10 son decisiones y limpieza.

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
3. **Orden**: barajado con semilla fija por sesión y segmento, ordenación por
   distancia a una energía objetivo, se cogen las 8 primeras (ver P3).
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
| `energy` | Planitud espectral de los fotogramas fuertes, en escala logarítmica; comparable entre canciones; ver P4 | Sí (orden y primera canción) |
| `intro_cue` | Primer instante con energía sobre el percentil 35 | Sí (punto de entrada) |
| `outro_cue` | Primer límite de frase unos 64 golpes antes del último sonido | Sí (punto de salida) |
| `sections` | Etiquetas intro/build/drop/breakdown/body/outro por bloques de 8 compases | No (P8) |
| `tempo_confidence` | Parte de golpes que encajan en la rejilla; ≤ 0,6 si el tempo deriva | Sí, dentro de `confidence` |
| `loudness_db` | — | No |
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

**Qué pasa.** En la ruta v6 (`_build_music_set_route`, la que usa siempre la web
porque envía `sources`):

1. `rng.shuffle(available)` (`auto_mode.py:1335`).
2. Energía objetivo: una de seis fases `(0.34, 0.52, 0.74, 0.9, 0.78, 0.58)`
   (`_auto_set_arc_position`), tomada como percentil de las energías medidas de
   las candidatas. Avanza en cada recarga de hasta 8 canciones.
3. `analysed.sort(...)` por distancia a esa energía (`auto_mode.py:1343`).
4. Se cogen las 8 primeras y se calcula la transición de cada par
   (`auto_mode.py:1378`).

No cuentan: la calidad de la transición, `score`, `semantic_score` ni el peso de
la fuente (`weight = 0.38 + 0.62·…`, línea 1254; solo se usa para elegir la
primera canción). Si ninguna candidata está analizada, el orden es el barajado.
Las canciones sin análisis usan la mediana de las energías medidas de las
candidatas (desde P4; antes, 0,5).

`README.md` dice que el modo DJ "orders songs by tempo, key and energy": hasta
P3, el tempo y la tonalidad no intervienen en el orden.

`order_route` (`dj_engine.py:767`) sí ordena con `0,42·transición + 0,38·semántica
+ 0,20·relevancia`, pero solo se usa en la ruta antigua sin `sources` (Android
sin fuentes), en Fix mix (`dj-repair`) y al colocar canciones (`dj-place`).

**Cuándo falla.** En cada recarga de la ruta. Dos canciones seguidas pueden ser
incompatibles en tempo o tonalidad aunque haya candidatas compatibles en el pool.
`docs/ARCHITECTURE.md` afirma que las fuentes se acumulan "with recency decay":
el peso se calcula pero no influye en la selección.

**Posibles soluciones.** Usar `order_route` en la ruta v6, añadiendo un término
de distancia al arco de energía y el peso de la fuente. Revisar los tests de
`tests/test_discovery_save_route.py` que fijan el comportamiento de v6.

## P4. La "energía" no mide intensidad

**Qué pasaba.** `energy = rms / percentil95(rms)` dentro de la misma canción, y
se guardaba la media. Medía lo uniforme que es el nivel de la canción, no lo
intensa que es: una canción acústica de nivel constante y un tema de EDM
comprimido podían dar el mismo valor.

Además, la primera canción de una sesión sin semilla se elegía comparando la
energía bruta con la posición del arco (0,34–0,9), mientras que el resto de la
ruta convierte esa posición en un percentil de las candidatas.

**Estado: cerrado.** `ANALYSER_VERSION` 5. Cambios:

- `energy` es la planitud espectral (media geométrica entre media aritmética de
  la potencia, 100–5000 Hz) de los fotogramas a menos de 20 dB del nivel fuerte
  de la canción, ponderada por su potencia, en escala logarítmica:
  0,002 → 0 y 0,25 → 1. Una ventana por debajo de −80 dBFS vale 0. En grabaciones
  de más de 8 minutos, media de los logaritmos de las dos ventanas.
- `frame_energy` (nivel relativo a la propia canción) no cambia: lo siguen usando
  `intro_cue` y `_sections_from_features`.
- `_build_music_set_route`: la primera canción se elige por distancia a la misma
  energía objetivo que el resto (el percentil del arco entre las candidatas), y
  las canciones sin medir cuentan como la mediana de las medidas.
- No hace falta normalizar sobre toda la biblioteca: la ruta ya ordena por
  posición entre las candidatas del momento.
- `energy` 0 es ahora un valor real (un coro, un piano solo). Los sitios que
  leían `analysis.get("energy") or 0.5` lo convertían en 0,5; ahora solo una
  canción sin medir cuenta como neutra (ruta v6 y dirección de la ruta antigua).

**Cómo se eligió (medido).** 221 canciones de menos de 8 minutos de la biblioteca
del usuario. 75 con una nota de intensidad de 1 (tranquila) a 5 (intensa) puesta
de oído antes de calcular nada. Correlación de rangos (Spearman) con esas notas:

| Medida | Spearman |
| --- | ---: |
| `energy` anterior | 0,23 |
| Planitud espectral (la nueva `energy`) | 0,84 |
| Nivel medio de los fotogramas fuertes (dB) | 0,54 |
| Media del flujo de ataques de `_rhythm_stft` | 0,49 |
| Parte de la potencia por encima de 2 kHz | 0,46 |
| Parte de la potencia por debajo de 150 Hz | 0,40 |
| Ataques por segundo | −0,06 |
| BPM | 0,19 |

Ninguna combinación de dos a cuatro medidas mejoró a la planitud sola en
validación cruzada dejando una fuera (la mejor, planitud + BPM, 0,830 frente a
0,829). La nota de cada canción la puso el asistente; el usuario revisa el orden
resultante de oído.

**Límites que quedan (medidos).**

- La música orquestal fuerte queda por debajo de lo que suena: la orquesta es
  tonal. Lohengrin, preludio del acto 3: 0,67, al nivel de una balada pop;
  Mozart, Sinfonía 25, 1.er movimiento: 0,43.
- La producción lo-fi con ruido o saturación sube: algunas canciones tranquilas
  de Joji dan 0,65–0,83.
- Un ruido sostenido (lluvia, ruido blanco) se mide como máxima intensidad.

**Coste.** Entre un 5 % y un 10 % más de tiempo de análisis, sin cambio de memoria
pico; ver `docs/PERFORMANCE.md`, *Energy (analysis version 5)*.

**Tests.** `tests/test_dj_energy.py` (acordes sostenidos contra batería densa,
independencia del nivel de máster, silencio, pausas con ruido de fondo, dos
ventanas), `test_dj_plan_v6_opens_at_the_arc_position_among_the_source_songs` y
`test_dj_plan_direction_reads_a_measured_zero_energy_as_calm`.

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

**Qué pasa.**

- La ruta v6 fija `"adaptive"` (`auto_mode.py:1378`) y no lee `direction`
  (energía, familiaridad, incluir/excluir).
- Con `adaptive` nunca salen `echo_cut` ni `long_blend`.
- Web: no hay selector. El perfil viene de `localStorage` `auto:dj-profile`
  (por defecto `adaptive`) y solo llega a `dj-transition`, `dj-place` y `dj-repair`.
- Android: `ProgramTransport.tsx:32` muestra un menú con los 4 perfiles y un
  diálogo de dirección (`mobile/DjDirection.tsx`). El perfil solo afecta a las
  transiciones que se recalculan, a Fix mix y a las colocaciones. La dirección
  solo se usa en la ruta antigua (petición sin `sources`).

**Cuándo falla.** En Android, cambiar de estilo o de dirección no cambia la ruta
generada ni la mayoría de sus transiciones.

**Necesita decisión del usuario.** La decisión vigente es "sin selector de
estilo". Opciones: (a) quitar el menú de estilo y de dirección de Android y fijar
el perfil en todos los endpoints; (b) dejar que el planificador elija la técnica
por par sin perfiles, permitiendo también `echo_cut` y `long_blend` cuando el
material lo pida (por ejemplo, echo_cut si el tempo no encaja pero la confianza es
alta). La opción (b) encaja con "la mezcla es automática".

## P8. Secciones medidas y no usadas

**Qué pasa.** `_sections_from_features` etiqueta bloques de 8 compases (intro,
build, drop, breakdown, body, outro), pero nadie lee las etiquetas. `outro_cue`
solo usa los límites de frase; `intro_cue` es el primer instante con sonido.
`loudness_db` no se usa al planificar; `tempo_confidence` solo entra en `confidence`.

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

- `api.interpretDjCommand` (`ui_web/src/lib/api.ts`) no tiene llamadores; el
  endpoint `/api/discovery/music/dj-command` y `_dj_command_direction` solo son
  alcanzables por él.
- `setAutoDjProfile` y `setAutoDirection` (`ui_web/src/stores/dj.ts`, declarados en
  `stores/contracts.ts`) no se llaman desde la web; `setAutoDirection` solo
  aparece en `stores/index.test.ts`.
- El campo `automation` que devuelve `plan_transition` no lo lee el mezclador web
  ni el de Android: los dos deciden por `technique`.
- `docs/AUTO_MODE.md` habla de "DJ style" (tabla de partes y "Depending on the
  material and DJ style").
- `docs/ARCHITECTURE.md` describe "recency decay" de las fuentes (ver P3).

Según las preferencias del usuario, el código 100 % sin uso se elimina sin
preguntar; hacerlo junto con P7, porque la decisión de P7 cambia qué queda vivo.
