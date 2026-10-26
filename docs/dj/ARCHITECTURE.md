# Responsabilidades del DJ tras la infraestructura de P12

P11 extrajo `ad59b838` sin cambiar medidas, órdenes ni planes. El punto de
entrada público sigue siendo `shared/dj_engine.py`: reexporta las funciones,
sin copias del estado de caché o de los trabajos. P12 añadió medidas métricas
locales y validación de ejecución ([P12](P12.md)). P12-b sustituye su detector
de pulso y compás por el elegido en la [comparativa P12-a](DETECTOR_COMPARISON.md):
Beat This! `final0` en ONNX Runtime con el DBN portado a NumPy. Los
adaptadores experimentales siguen fuera de estos propietarios de producción.

## Propietarios y dependencias

Todos los módulos musicales están en `shared/dj/`. Solo `store` accede a disco,
SQLite, FFmpeg, runtime y trabajos, y solo `weights` a los pesos del modelo y
su descarga. Los módulos puros se pueden importar sin cargar el
almacenamiento ni Flask; una prueba lo comprueba en otro proceso.

| Módulo | Responsabilidad y salida | Dependencias DJ |
| --- | --- | --- |
| `contracts` | `Analysis`, `AnalysisSummary`, `WindowFeatures`, `RhythmWindow`, `Structure`, `TransitionPlan`, unidades, versión de análisis y ausencia de evidencia | Ninguna |
| `beat_model` | Espectrograma log-mel, predicción por bloques de Beat This! con una sesión dada y tiempo de cada pulso entre tramas | `dbn` |
| `dbn` | Decodificación conjunta de pulsos y unos (3/4 pulsos, 55–215 BPM), igual a madmom | Ninguna |
| `rhythm` | Rejilla precisa a partir de los pulsos del modelo (recta/curva local y ataques de P1), observaciones armónicas/ataques y subdivisión por región | `contracts`, `metre` |
| `metre` | Compás y unos estimados por el modelo por región; confirmación independiente con agrupaciones de 2/3/4/6 pulsos; abstenciones | Ninguna |
| `features` | Ataques de notas, tonalidad, textura y medidas de una ventana | `rhythm`, `contracts` |
| `structure` | Compases recibidos, frases, secciones y cues candidatos sobre las ventanas medidas | `contracts` |
| `analysis` | Diezmado a 11025 Hz y composición de las medidas completas; agrega ventanas sin rellenar huecos | `features`, `structure`, `contracts` |
| `weights` | Pesos ONNX: ruta empaquetada o caché, SHA-256, descarga única y sesión de un hilo | Ninguna (runtime) |
| `store` | Identidad, sello del contenido, SQLite, decodificación a 22050 Hz con LUFS en la misma pasada, inferencia serializada y DSP fuera de gevent, trabajos acotados | `analysis`, `beat_model`, `weights`, `contracts` |
| `timing` | Periodo y métrica locales, equivalencia de medio/doble pulso, deriva y admisión de beatmatch | `contracts` |
| `transitions` | Único `plan_transition`: compatibilidad, técnica, cues, velocidad y eco | `timing`, `features` (nombres de notas), `contracts` |
| `routes` | Continuidad, ruta legacy, llegada a peticiones, elección de hueco y reparación entre anclas | `transitions`, `timing`, `contracts` |
| `shared/dj_pool.py` | Admisión de puentes dentro del conjunto fijado antes de consultar caché | `transitions`, `timing` |
| `shared/dj_library.py`, `shared/preview_cache.py` | Adquisición desde biblioteca y previews completas | Fachada → `store` |
| `shared/api/routes/auto_mode.py` | Fuentes, referencias, sesión, adquisición, llamadas a políticas puras y adaptación HTTP | Fachada, `routes`, `contracts`, `dj_pool` |

No hay imports de almacenamiento desde los módulos puros ni dependencias de
vuelta desde el planificador hacia HTTP. Los endpoints ya no contienen la
búsqueda de hueco, puntuación de peticiones ni reconstrucción musical de la
reparación. Las fuentes y el recomendador siguen eligiendo el conjunto.

## Contratos, unidades y cobertura

Los `TypedDict` describen las fronteras y conservan el JSON actual. Los aliases
`Seconds`, `BeatsPerMinute` y `PlaybackRatio` hacen explícitas sus unidades sin
añadir envoltorios al PCM o al formato persistido. `AnalysisInput` admite
lecturas parciales/antiguas; un tipo completo no da por validada esa entrada.

- `WindowFeatures` y `RhythmWindow` usan segundos relativos a la ventana. Su
  cobertura es `[offset, offset + window_seconds]`. `Structure` transforma esos
  puntos a segundos absolutos, sin prolongar la rejilla entre cabeza y cola.
- `Analysis` conserva las listas completas de golpes, unos, frases, secciones
  y `metric_regions`. `AnalysisSummary` las omite para v6; no elimina escalares desconocidos,
  ceros ni futuras medidas. Los demás endpoints conservan su respuesta previa.
- `note_rate` y `spectral_flatness`: `None` significa sin medida; cero es válido.
  `loudness_lufs = None` también puede significar que el medidor no tiene
  lectura, por ejemplo en silencio. BPM cero expresa pulso desconocido.
  `outro_cue = None` requiere colocar el fundido con la duración cargada.
  Lista vacía expresa falta de evidencia de rejilla/estructura.
- `confidence` sigue combinando tempo y tonalidad. En `metric_regions`,
  `beats_per_bar`, `bar_seconds` y `downbeats` son la estimación del modelo
  (P12-b); `metre_confidence` y `downbeat_confidence` solo dejan de ser cero
  si la agrupación independiente coincide en tamaño y fase. Ninguna es una
  probabilidad calibrada de acierto musical. `bar_seconds` puede ser `None`:
  no se rellena lo desconocido con cuatro pulsos. El resumen escalar también
  distingue cambios o desconocidos. Frases y secciones conservan el supuesto
  de ocho compases sobre los unos del modelo; P13 sigue pendiente.
- `TransitionPlan` es la decisión ejecutable del servidor. `score` describe
  compatibilidad para ordenar; no certifica que se ejecute beatmatch. El eco
  mantiene su periodo saliente medido. P12 añade vectores métricos compartidos
  sin regenerar los vectores legacy de P7/P8/P9. P12-b cambia `three-to-four`
  a `beats` por decisión del usuario y añade tres vectores de `beats`.

`timing.pulse_relations` da el ciclo común de dos pulsos (m pulsos de la que
sale = n de la que entra, relaciones 2ᵃ·3ᵇ) y su velocidad; lo comparten
puntuación, entrada al drop, velocidad final, `metric_sync` y admisión de
puentes. El contrato antiguo sin `metric_regions` conserva `comparable_ratio`,
el plegado de una octava en 0,7/1,4. `tempo_coordinate` conserva la proyección logarítmica de BPM sobre
la octava de la referencia de ruta: es otra operación y tiene otro objetivo.
`local_period` conserva el ajuste sobre la rejilla alrededor del cue.
`rate_fits` usa los periodos y la velocidad redondeados y todo el solapamiento;
el límite del planificador sigue siendo 5 ms. La admisión de puentes verifica
además BPM y técnica, y rechaza planes antiguos incompletos o valores inválidos.
`metric_sync` declara lo que los dos reproductores pueden mantener durante
todo el tramo: `bars` con unos confirmados en ambas canciones, compases
ejecutados iguales, fase de ambos cues y rejillas estables; `beats` (P12-b)
con pulso estable compartido, ambos cues en pulsos medidos y rejillas
regulares sin huecos, y el compás estimado común solo como guía de
recolocación; `none` en el resto. El score musical anterior se conserva para
mezclas ejecutables y pasa a cero con `none`. `beatmatch_fits` es la misma admisión para
puentes de fuentes y de peticiones con medidas nuevas. Las entradas sin
`metric_regions` conservan explícitamente el contrato legacy; P11-a sigue
visible para esa política anterior.

Las guardas propias de cada reproductor siguen comprobando identidad, duración,
solapamiento, velocidad y pertenencia del plan; compartir una regla del servidor
no sustituye esa frontera de ejecución.

## Inventario de políticas

| Entrada | Orden/elección | Puentes y restricciones |
| --- | --- | --- |
| `dj-plan` con fuentes, v6 | Conjunto/barajado independiente de caché; `order_continuous_route`: déficit de `score` y diferencias de notas/s, LUFS, planitud y BPM, normalizados por dispersión; posiciones frías fijas | `add_measured_bridges`: semilla y conjunto entero medidos, ambos tramos con técnica de beatmatch y deriva ejecutada admisible; conserva todos los destinos |
| `dj-plan` legacy, relleno v4 | `order_route`: 0,42 transición + 0,38 semántica + 0,20 relevancia; secuencia de fuentes; calidad neutra 0,62 ante análisis ausente | No amplía el conjunto como v6; analiza la ruta aceptada |
| Peticiones legacy de canción/artista | `choose_request_segment` → `route_to_request`; media de `score`, relevancia del destino y costes de demora ya existentes | Beam de hasta 48 estados, 12 candidatas, hasta cuatro puentes; destino preferido a continuación. P12 exige `beatmatch_fits` en cada tramo métrico, incluido el final; sin contrato métrico conserva P11-a |
| `dj-place` automático | `choose_placement`: media de transiciones de entrada y salida, menos 0,009 por hueco; empate favorece el hueco anterior | Hasta dos puentes; con posición fijada no se adquieren ni se admiten puentes |
| `dj-repair` | `repair_route`: anclas y profundidad conservadas; relleno con `order_route`; bonificación de estabilidad 0,06 a las filas existentes | Llegada al ancla con `route_to_request`, hasta dos puentes; techo de 16; no crece por relleno. Las exclusiones no anulan anclas explícitas |
| `dj-transition` | Solo `plan_transition` contra las medidas actuales de los dos archivos; sin elegir canciones ni reordenar | Lectura de caché y eventual programación asíncrona; sin decodificación dentro de la petición |

La doble influencia del tempo se conserva explícitamente: el `score` usa el
desajuste de BPM global para describir compatibilidad del par (junto con armonía
y confianza); la distancia de continuidad usa BPM para mantener próximas las
magnitudes de la ruta. La dispersión de cada dimensión determina su escala.
No son dos confirmaciones independientes del pulso ni dos estimaciones del
compás. P11 no añade pesos ni recalibra esa influencia. P12 conserva los pesos
y aplica la validez métrica como requisito binario, no como otro peso de gusto.
La diferencia entre
continuidad v6 y semántica/relevancia legacy es deliberada y ya figuraba en P3.

### P11-a: resuelto para medidas métricas; pendiente en entradas legacy

Contradicción confirmada que esta extracción conserva: `route_to_request`
declara mejorar la seguridad pero compara solamente `score`. En la fixture
medida 100 → 107 → 114 BPM devuelve un puente con dos `echo_cut`, puntuaciones
0,602/0,625 y velocidad 1; ambos desajustes superan el límite de 6 %. Para el
mismo conjunto, `add_measured_bridges` conserva el destino directo, porque
ningún tramo hace beatmatch. Una puntuación armónica alta tampoco asegura una
velocidad local ejecutable aunque los BPM globales coincidan.

P12 exige ambos tramos ejecutables para las medidas nuevas y comparte su
validador con `dj_pool`. La fixture histórica sin `metric_regions` conserva el
resultado descrito. Para esas entradas legacy, el subpunto deberá decidir si
todos los puentes de petición tienen que superar la misma prueba de ejecución que los de fuentes, y cómo comparar las
técnicas de reserva sin presentar `score` como seguridad. Afecta a peticiones
legacy, colocación y reparación. Tiene caso permanente en
`test_dj_boundaries.py`; no se cambia de política dentro de P11. Esta
discrepancia legacy sigue visible tras P12-b.

## Evidencia de extracción

`python -I docs/dj/extraction_probe.py --reference ad59b838` ejecuta el monolito
anterior y los módulos actuales con las mismas dependencias y señales, sin
datos personales. Exige igualdad completa, no una nueva expectativa generada:

- 7 análisis PCM: pulsos a 90/137 BPM, silencio, tono, ruido, regiones de nivel
  conocido y grabación de 600 s medida por cabeza/cola. Ningún golpe se añade
  en el hueco entre 90 y 480 s.
- 784 pares y 168 rutas, incluidos datos fríos, ceros, duración desconocida,
  medio/doble tempo, confianza baja, archivo corto y mezcla larga.
- WAV/AAC: una decodificación por archivo y análisis idéntico; cuatro lecturas
  sin decodificación de filas antiguas/nuevas en ambos sentidos. Misma versión
  del analizador y esquema de SQLite; no se invalida la caché.

Las pruebas existentes conservan sus expectativas musicales y vectores HTTP,
web y Android. Los puntos privados de inyección migran al propietario:
`store._cache_path`, `store._analyse_pcm`, `store._decode_measured` y
`store._compose` para almacenamiento/ejecución fuera del bucle;
`features._spectral_features` para FFT y `analysis._compose` para PCM puro.
Los imports públicos de la fachada siguen funcionando con una sola instancia
del estado. Los probes de tempo y tonalidad y los benchmarks de análisis/cola
usan esos propietarios; la instrumentación de la cola observa el trabajo real
de `store`, y las revisiones separadas se cargan en otro namespace.

Se mantienen dos trabajadores de adquisición, hasta 64 identidades pendientes,
deduplicación por identidad, conexiones SQLite por hilo, FFT por bloques y
despacho del DSP al threadpool nativo cuando hay gevent. Las pruebas comprueban
esos límites y la no obstrucción del bucle cooperativo. No se fusionan las FFT
de ritmo, tonalidad y ataques de notas ni se afirma una mejora de rendimiento:
P11 cambia la organización y las fronteras.
