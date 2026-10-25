# Responsabilidades del DJ tras P11

Extracción de `ad59b838`, sin cambiar medidas, órdenes ni planes. El punto de
entrada público sigue siendo `shared/dj_engine.py`: reexporta las funciones,
sin copias del estado de caché o de los trabajos. P12 revisará el compás y el 1;
P13, frases y secciones. Sus suposiciones actuales siguen vigentes.

## Propietarios y dependencias

Todos los módulos musicales están en `shared/dj/`. Solo `store` accede a disco,
SQLite, FFmpeg, runtime y trabajos. Los módulos puros se pueden importar sin
cargar el almacenamiento ni Flask; una prueba lo comprueba en otro proceso.

| Módulo | Responsabilidad y salida | Dependencias DJ |
| --- | --- | --- |
| `contracts` | `Analysis`, `AnalysisSummary`, `WindowFeatures`, `RhythmWindow`, `Structure`, `TransitionPlan`, unidades, versión de análisis y ausencia de evidencia | Ninguna |
| `rhythm` | Pulso, rejilla y fase del compás de una ventana PCM | `contracts` |
| `features` | Ataques de notas, tonalidad, textura y medidas de una ventana | `rhythm`, `contracts` |
| `structure` | Compases recibidos, frases, secciones y cues candidatos sobre las ventanas medidas | `contracts` |
| `analysis` | Composición de las medidas completas; agrega ventanas sin rellenar huecos | `features`, `structure`, `contracts` |
| `store` | Identidad, sello del contenido, SQLite, decodificación, LUFS en la misma pasada, trabajos acotados y despacho del DSP fuera de gevent | `analysis`, `contracts` |
| `timing` | Periodo local, equivalencia de medio/doble pulso, coordenada de tempo y presupuesto de deriva ejecutada | `contracts` |
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
- `Analysis` conserva las listas completas de golpes, unos, frases y secciones.
  `AnalysisSummary` las omite para v6; no elimina campos escalares desconocidos,
  ceros ni futuras medidas. Los demás endpoints conservan su respuesta previa.
- `note_rate` y `spectral_flatness`: `None` significa sin medida; cero es válido.
  `loudness_lufs = None` también puede significar que el medidor no tiene
  lectura, por ejemplo en silencio. BPM cero expresa pulso desconocido.
  `outro_cue = None` requiere colocar el fundido con la duración cargada.
  Lista vacía expresa falta de evidencia de rejilla/estructura.
- `confidence` sigue combinando tempo y tonalidad: no se convierte en confianza
  métrica. `bar_seconds` mantiene el supuesto de cuatro pulsos y las frases y
  secciones mantienen los bloques de ocho compases. P12/P13 los revisarán.
- `TransitionPlan` es la decisión ejecutable del servidor. `score` describe
  compatibilidad para ordenar; no certifica que se ejecute beatmatch. El eco
  mantiene su periodo saliente medido. No se cambia ningún vector compartido.

`timing.comparable_ratio` conserva el plegado de una octava en los límites
0,7/1,4, compartido por puntuación, entrada al drop, velocidad final y admisión
de puentes. `tempo_coordinate` conserva la proyección logarítmica de BPM sobre
la octava de la referencia de ruta: es otra operación y tiene otro objetivo.
`local_period` conserva el ajuste sobre la rejilla alrededor del cue.
`rate_fits` usa los periodos y la velocidad redondeados y todo el solapamiento;
el límite del planificador sigue siendo 5 ms. La admisión de puentes verifica
además BPM y técnica, y rechaza planes antiguos incompletos o valores inválidos.
Las guardas propias de cada reproductor siguen comprobando identidad, duración,
solapamiento, velocidad y pertenencia del plan; compartir una regla del servidor
no sustituye esa frontera de ejecución.

## Inventario de políticas conservadas

| Entrada | Orden/elección | Puentes y restricciones |
| --- | --- | --- |
| `dj-plan` con fuentes, v6 | Conjunto/barajado independiente de caché; `order_continuous_route`: déficit de `score` y diferencias de notas/s, LUFS, planitud y BPM, normalizados por dispersión; posiciones frías fijas | `add_measured_bridges`: semilla y conjunto entero medidos, ambos tramos con técnica de beatmatch y deriva ejecutada admisible; conserva todos los destinos |
| `dj-plan` legacy, relleno v4 | `order_route`: 0,42 transición + 0,38 semántica + 0,20 relevancia; secuencia de fuentes; calidad neutra 0,62 ante análisis ausente | No amplía el conjunto como v6; analiza la ruta aceptada |
| Peticiones legacy de canción/artista | `choose_request_segment` → `route_to_request`; media de `score`, relevancia del destino y costes de demora ya existentes | Beam de hasta 48 estados, 12 candidatas, hasta cuatro puentes; destino preferido a continuación. No exige beatmatch ejecutado: véase P11-a |
| `dj-place` automático | `choose_placement`: media de transiciones de entrada y salida, menos 0,009 por hueco; empate favorece el hueco anterior | Hasta dos puentes; con posición fijada no se adquieren ni se admiten puentes |
| `dj-repair` | `repair_route`: anclas y profundidad conservadas; relleno con `order_route`; bonificación de estabilidad 0,06 a las filas existentes | Llegada al ancla con `route_to_request`, hasta dos puentes; techo de 16; no crece por relleno. Las exclusiones no anulan anclas explícitas |
| `dj-transition` | Solo `plan_transition` contra las medidas actuales de los dos archivos; sin elegir canciones ni reordenar | Lectura de caché y eventual programación asíncrona; sin decodificación dentro de la petición |

La doble influencia del tempo se conserva explícitamente: el `score` usa el
desajuste de BPM global para describir compatibilidad del par (junto con armonía
y confianza); la distancia de continuidad usa BPM para mantener próximas las
magnitudes de la ruta. La dispersión de cada dimensión determina su escala.
No son dos confirmaciones independientes del pulso ni dos estimaciones del
compás. P11 no añade pesos ni recalibra esa influencia. La diferencia entre
continuidad v6 y semántica/relevancia legacy es deliberada y ya figuraba en P3.

### P11-a pendiente: puntuación frente a ejecución en puentes de peticiones

Contradicción confirmada que esta extracción conserva: `route_to_request`
declara mejorar la seguridad pero compara solamente `score`. En la fixture
medida 100 → 107 → 114 BPM devuelve un puente con dos `echo_cut`, puntuaciones
0,602/0,625 y velocidad 1; ambos desajustes superan el límite de 6 %. Para el
mismo conjunto, `add_measured_bridges` conserva el destino directo, porque
ningún tramo hace beatmatch. Una puntuación armónica alta tampoco asegura una
velocidad local ejecutable aunque los BPM globales coincidan.

El subpunto deberá decidir y documentar si los puentes de petición tienen que
superar la misma prueba de ejecución que los de fuentes, y cómo comparar las
técnicas de reserva sin presentar `score` como seguridad. Afecta a peticiones
legacy, colocación y reparación. Tiene caso permanente en
`test_dj_boundaries.py`; no se cambia de política dentro de P11. El siguiente
punto de la secuencia acordada continúa siendo P12, con esta discrepancia
identificada para que no quede oculta.

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
del estado. Los probes de tempo y tonalidad usan esos propietarios.

Se mantienen dos trabajadores de adquisición, hasta 64 identidades pendientes,
deduplicación por identidad, conexiones SQLite por hilo, FFT por bloques y
despacho del DSP al threadpool nativo cuando hay gevent. Las pruebas comprueban
esos límites y la no obstrucción del bucle cooperativo. No se fusionan las FFT
de ritmo, tonalidad y ataques de notas ni se afirma una mejora de rendimiento:
P11 cambia la organización y las fronteras.
