# Traspaso: revisión del modo DJ

Punto de entrada para revisar y mejorar el modo DJ punto por punto, en sesiones
nuevas y sin el historial del chat. El diagnóstico original parte de `main` en
`f1e79d30`; la segunda fase (P11–P13), acordada el 2026-10-25, se contrasta con
`main` en `ad59b838`. Los números de línea de los diagnósticos originales son
históricos; buscar por nombre de función en el código vigente.

El documento empezó como diagnóstico. Los puntos cerrados lo indican en la tabla
de estado y en su sección; el resto sigue siendo diagnóstico.

## Cómo trabajar con este documento

- Revisar **un punto por sesión** (o los que el usuario indique). Para la
  continuación de P12, el usuario autoriza bloques amplios y una comparativa
  casi de extremo a extremo; ver P12-a/P12-b. Al cerrar un punto, actualizar
  su fila en la tabla de estado y su sección, con el commit o PR.
- Respetar `AGENTS.md`: rama + PR, etiqueta `impact:*`, esperar CI, no merge sin
  permiso del usuario, no `npm run build`, suite completa de Playwright si se toca
  `ui_web/`.
- Cualquier cambio en las medidas o su significado debe subir
  `ANALYSER_VERSION`: la caché `cache/dj/analysis.sqlite3` está indexada por esa
  versión y las medidas antiguas no se invalidan de otro modo. Esto sigue
  aplicándose cuando P11 mueva el análisis a otros módulos; una extracción que
  conserve exactamente las medidas y su formato no exige invalidarlas.
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
| P2 | Alineación de fase en el navegador | Traza de la estación: un `seek` en el cue dejó 115 ms de desfase 30 s, oído por el usuario | Cerrado en la web (PR #395): fase mantenida con `playbackRate` durante la mezcla; Android sin medir |
| P3 | El orden de la ruta ignora la calidad de la transición | Tests de magnitudes, audio sintético → HTTP y replay de análisis locales | Cerrado (implementación `0e62b0fb`) |
| P4 | La "energía" no mide intensidad | Medido | Cerrado (#385): notas/s, LUFS y planitud; `energy` eliminado |
| P5 | Pool analizado, previews y canciones puente | AAC → caché → HTTP, pools fríos/calientes y adquisición real de 16 previews | Cerrado (implementación `31f696bc`) |
| P6 | Compatibilidad de tonalidad mal puntuada | Medido: 576 pares y cadencias conocidas | Cerrado (`af6521f1`); detector y límites documentados abajo |
| P7 | Selección automática de técnicas, sin perfiles | AAC → SQLite → HTTP en planificación, colocación, reparación y refinado; vectores comunes web/Android | Cerrado (implementación `d678f625`): opción (b) |
| P8 | Secciones medidas y no usadas | AAC → SQLite → HTTP; vectores comunes ejecutados por web y Android | Cerrado (implementación `90b6c7e9`) |
| P9 | Eco no sincronizado con el tempo | AAC → SQLite → HTTP; impulsos en Web Audio real y PCM nativo | Cerrado (`a8a22618`); activación automática cerrada en P7 (`d678f625`) |
| UI1 | Selección externa inicia una sesión nueva desde lo seleccionado; gestión dentro del shell | Pruebas de store, navegador y contrato nativo | Cerrado (#389) |
| P10 | Código muerto y documentación desactualizada | Sin lectores de `automation`; tipos y contrato retirados | Cerrado (#385 y `d678f625`) |
| P11 | Rewrite por responsabilidades, contratos y coherencia de políticas | Igualdad antes/después: 7 análisis, 784 planes, 168 rutas y caché WAV/AAC bidireccional; contratos y políticas inventariados | Cerrado (implementación `67d086cf`); discrepancia P11-a registrada |
| P12 | Compás, subdivisión, identificación del 1 y sus confianzas | Contratos y guardas en #394; detector de P12-b medido de extremo a extremo sobre el corpus de P12-a (`integrated-p12b.json`) | Cerrado con P12-b; límites abajo |
| P12-a | Estimación conjunta y comparativa de detectores abiertos | 29 configuraciones × 62 entradas + 5 AAC, contrato HTTP y ejecución sin PyTorch; [resultados](detector_comparison/RESULTS.md) | Cerrado (PR #395): mediciones completas y decisión del usuario (2026-10-26): Beat This! `final0` |
| P12-b | Integración del método elegido y cierre de P12 | DBN igual a madmom 62/62; GTZAN tempo 24/30 y F1 del 1 0,81; P1 en verde; `beats`/`bars` en servidor, web y Android | Cerrado (PR #395, junto con P12-a) |
| P13 | Frases y secciones sobre una base métrica explícita | Ocho compases contados desde los unos del modelo; fixtures `structure_*` en el corpus de P12-a | **Siguiente trabajo** |

Orden acordado con el usuario (2026-10-22): **P4 rehecho → P6 → P3 → P5
ampliado**, después P8 y P9. P7 y P10 son decisiones y limpieza. P2 no se trabaja
salvo que vuelva el síntoma. P4, P6, P3, P5, P8 y la sincronización de P9 están
cerrados. **P7 y P10 también están cerrados en `d678f625`; UI1 está cerrado en
#389.** P2 sigue aparcado: solo se retoma si vuelve el síntoma de desfase.

**Siguiente trabajo acordado (2026-10-25): P11 → P12 → P13.** Los cierres de la
primera fase se conservan con su alcance original: P1 mejoró la precisión del
pulso y P8 empezó a utilizar las secciones existentes; no resolvieron la
detección general del compás, del 1 ni de las frases musicales. P2 corrige la
alineación temporal de reproducción; no corrige una interpretación musical
equivocada aunque los dos reproductores coincidan al milisegundo.

**P12 se cierra con P12-b; el siguiente trabajo es P13.** Historia: el cierre
anterior fue prematuro: `2ca8ccf2` y la PR #394 aportan contratos y guardas,
pero los doce fragmentos Ballroom no acreditan compás y 1 correctos. El usuario
acuerda probar estimación conjunta y varias soluciones abiertas mantenibles,
compararlas y decidir con los resultados. **La comparativa está medida y
el usuario ha decidido (2026-10-26); el siguiente trabajo es P12-b.**
Resultados y límites en [detector_comparison/RESULTS](detector_comparison/RESULTS.md).

**Decisiones del usuario (2026-10-26):**

- Detector: **Beat This! `final0`** con su DBN de 3/4 pulsos. Se ejecuta con
  ONNX Runtime y frontend NumPy, sin PyTorch ni madmom en el motor: PyTorch no
  publica Windows arm64 y madmom solo existe como código fuente de 2018 con
  pesos CC BY-NC-SA. El DBN se porta a NumPy y se verifica contra las salidas
  retenidas de la comparativa.
- Guardas: **beatmatch por pulso cuando el pulso es fiable**; alineación de
  compases solo con evidencia adicional del 1. La activación de la red no es
  esa evidencia: no separa aciertos de errores. Cambia la política de P12,
  que hoy exige compases para cualquier beatmatch.
- Versión: **no publicar ninguna versión hasta integrar P12-b**, en lugar de
  revertir #394.
- Velocidad: el límite de estiramiento de la canción que entra pasa del 6 % al
  8 %, el rango de pitch de un plato o CDJ (120 ↔ 128 BPM, 6,7 %, se oía
  mezclable y caía en `echo_cut`). Pendiente como punto propio: repartir el
  cambio de tempo entre las dos canciones durante la mezcla (cada una ≤ 8 %,
  hasta ~16 %, p. ej. 120 ↔ 140) y volver gradualmente; requiere variar la
  velocidad de ambas manteniendo la fase en web y Android.
- Puerta del beatmatch: **solo la ejecución decide si hay fallback**. Si los
  dos pulsos son estables y la velocidad local cabe en el 8 % con ≤ 5 ms de
  desfase, hay beatmatch. Se quita la puerta `score ≥ 0,55`: con ella la
  tonalidad provocaba fallbacks (120 La menor ↔ 128 Sol menor sacaba 0,495 y
  sonaba en `echo_cut`) y la parte de tempo dejaba un límite oculto cerca del
  7 %. Todos los intervalos entre tonalidades se consideran mezclables; la
  clasificación Camelot se conserva para ordenar la ruta y elegir entre
  bass_swap (≥ 0,72), filter_blend y long_blend (armonía ≥ 6/7). Medido en
  6000 parejas de la biblioteca del usuario: entre un 6 y un 8 % de diferencia
  de tempo, el beatmatch pasa del 2 % al 75 %; entre un 4 y un 6 %, del 26 % al
  78 %.
- 1 contado desde el primer 1 medido: si el cue cae en un tramo donde el
  modelo no da ningún 1 (una intro de contrapunto que sugiere otro 1, como
  «Teardrops (Rules Remix)»), el cue se pone a compases enteros del 1 medido
  más cercano a lo largo del mismo pulso, primero el siguiente: el compás que
  revela la entrada de la batería. Solo con rejilla regular, sin huecos y
  pulso estable hasta ese 1 (`projected_bar`). La recolocación usa ese compás.
  La garantía sigue siendo `beats`. Medido en la estación: el plan anterior
  ponía el 1 de la batería en el 2 de la saliente. En la biblioteca del
  usuario, 17 de 227 canciones con pulso estable tienen este patrón en su cue
  de entrada.
- Ciclo común: lecturas binarias y ternarias son equivalentes; dos canciones
  se mezclan con beatmatch en cualquier relación 2ᵃ·3ᵇ de pulsos que los
  reproductores puedan mantener (incluida 3:2, p. ej. 116 ↔ 174), alineando el
  ciclo común desde los dos unos. Dentro de la PR de P12-b.
- Pesos: el `.onnx` de `final0` (84 MB, MIT) se publica como asset de una
  release de GitHub de Soundsible con SHA256 fijado. La imagen Docker y el
  instalador de escritorio lo incluyen; una instalación desde código lo
  descarga la primera vez.

**Regresión medida en `main` (#394, sin publicar todavía).** Con las 30
grabaciones GTZAN no vistas, el tempo correcto baja de 21 a 10 y el 1 real no
se identifica en ninguna (F1 0). En la caché local del usuario, 162 de 278
canciones cambian de BPM respecto a v8 (66 ×1,5) y el 1 cubre de media el
2,2 % de cada canción v9: casi todas las transiciones con música real son de
reserva. El usuario decide retener la próxima versión hasta P12-b.

**Orden de desarrollo acordado (2026-10-25): banco/adaptadores y comparativa
P12-a → resultados y decisión del usuario → integración P12-b → P13.** Para
ahorrar reescrituras, preparar fixtures de P13 durante la comparativa y poder
entregar su implementación junto a P12-b si comparten una métrica ya elegida,
con aceptaciones independientes. No cambiar producción por candidato. El plan
operativo único está en [DETECTOR_COMPARISON](DETECTOR_COMPARISON.md).
P11-a queda resuelto para medidas nuevas y pendiente para entradas sin
contrato métrico; no es otro detector que haya que reescribir en la comparativa.

Por qué este orden: P3 ordena con las medidas de P4 y con la puntuación de
tonalidad de P6 (`plan_transition`: `0,46·tempo + 0,32·armonía + 0,22·confianza`),
así que va después de los dos. P5 amplía el pool que P3 ordena.

## Decisiones de diseño (2026-10-22)

### Selección externa y control de sesión (2026-10-24)

Con DJ activo, reproducir música desde fuera del shell inicia una sesión nueva:
la canción seleccionada arranca desde cero y es la única fuente; elegir una
colección usa esa colección como fuente y empieza por su primera canción.
Se descartan las fuentes, peticiones, exclusiones, exploración y ruta anteriores;
el planificador nuevo tiene otra identidad. Las respuestas y callbacks de la
sesión anterior no pueden reponerla. Web y Android comparten esta regla, incluida la selección desde Android Auto.

La gestión de una sesión en curso queda dentro del shell: añadir fuentes,
pedir/colocar canciones, cambiar el material sin cortar la actual y reparar la
ruta. Los menús externos ofrecen empezar DJ, sin acciones para editar la sesión
actual. Entrar en DJ desde NORMAL y los cambios pedidos desde el propio shell
conservan su contrato anterior.

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
web y Android, porque ya nada puede fijarla. Tras #385 ambos clientes enviaban `dj_profile: "adaptive"`. P7 (`d678f625`)
retira también ese parámetro de los clientes y los perfiles del servidor: la
técnica se decide por par. El servidor ignora el campo de clientes antiguos.

---

## Cómo funciona hoy

### Archivos

| Parte | Archivo |
| --- | --- |
| Entrada pública (reexports, sin estado propio) | `shared/dj_engine.py` |
| Contratos, almacenamiento, análisis, estructura, reglas temporales, transiciones y rutas | `shared/dj/`; mapa de dependencias en [ARCHITECTURE](ARCHITECTURE.md) |
| Modelo de pulso y unos (Beat This! en ONNX Runtime, DBN en NumPy) y sus pesos | `shared/dj/beat_model.py`, `shared/dj/dbn.py`, `shared/dj/weights.py`; avisos en `shared/dj/third_party/` |
| Admisión de puentes del conjunto medido | `shared/dj_pool.py` |
| Endpoints `dj-plan`, `dj-place`, `dj-repair`, `dj-transition` | `shared/api/routes/auto_mode.py` |
| Cuándo y cómo se lanza cada transición (navegador) | `ui_web/src/stores/dj.ts` |
| Ejecución de la mezcla con dos reproductores | `ui_web/src/lib/audio/mixer.ts` |
| Nodos de filtro y eco | `ui_web/src/lib/audio/graph.ts` |
| Android: pide los planes al mismo servidor y mezcla en nativo | `android/.../ProgramDjPlanner.kt`, `ProgramDjRefiner.kt`, `ProgramMixCurve.kt` |
| Documentación de usuario | `docs/AUTO_MODE.md` |

### Flujo

1. **Análisis** (`analyse_audio`). La biblioteca local de todas las cuentas se
   recorre en segundo plano al arrancar y cada cinco minutos (sin podcasts ni
   audio disponible solo en la nube). Las previews se analizan al completar su
   adquisición. Cada recarga prepara un conjunto acotado de candidatas (P5). FFmpeg decodifica una
   vez a mono, 22050 Hz, con el medidor LUFS en la misma pasada. Beat This!
   `final0` (ONNX Runtime, un hilo, una inferencia a la vez) y el DBN dan pulsos
   y unos; el resto de medidas usan la misma ventana diezmada a 11025 Hz en
   NumPy. Solo se guardan las medidas en SQLite. En segundo plano, 2 trabajos
   (`request_analysis`). Canciones de más de 8 minutos: solo los primeros 90 s y
   los últimos 120 s. Sin pesos verificados no se analiza ni se guarda nada
   (P12-b). Mientras no hay análisis se usa `contracts.fallback_analysis()` con
   `confidence` 0,18.
2. **Candidatas** (`_build_music_set_route`, `auto_mode.py:1219`): canciones de cada
   fuente, más las "related" de YouTube Music (25 por semilla) de las últimas 4
   canciones de cada fuente, más las related de las últimas 4 canciones
   automáticas que llegaron a sonar ("exploration"). Se quitan excluidas, ya
   oídas y grabaciones de más de 20 minutos.
3. **Selección y orden**: barajado con semilla fija por sesión y segmento; se
   elige un conjunto de hasta 16 candidatas antes de leer su análisis. Las
   primeras 8 (o el `limit` pedido) son los destinos de la ruta; el resto son
   posibles puentes. Las posiciones medidas se ordenan por calidad de transición
   y continuidad en las cuatro magnitudes de P4 (P3). Las no analizadas conservan
   su posición. Solo con todo el conjunto y la semilla medidos se pueden insertar
   puentes, sin retirar destinos originales (P5). Una sesión sin semilla abre
   desde la fuente más reciente, según el barajado.
4. **Transición de cada par** (`plan_transition`, `shared/dj/transitions.py`), con selección
   automática de técnica (P7), común a todos los endpoints.
5. **Ejecución** en el navegador (`stores/dj.ts`, `mixer.ts`).

### Medidas por canción (`_compose`, `_window_features`)

| Campo | Cómo se calcula | ¿Se usa al planificar? |
| --- | --- | --- |
| `bpm` | Recta (o curva local) por los pulsos del modelo, ponderada por el ataque de cada uno; ver P1 y P12-b | Sí |
| `beat_grid` | Pulsos del modelo donde los hay (sin prolongarlos), fase y periodo fijados con los ataques, 4 decimales | Sí |
| `downbeats` | Unos estimados por el modelo, en puntos de la rejilla (P12-b) | Sí |
| `metric_regions` | Pulsos/compás y unos: estimación del modelo. `metre/downbeat_confidence`: confirmación independiente (cambios armónicos y acentos sobre la misma rejilla), cero si no coincide. Subdivisión medida; desconocidos explícitos | Sí, validez del par y del solapamiento; el plan transmite solo dos coberturas compactas |
| `key`, `mode` | Correlación de Pearson con los perfiles Krumhansl; croma con resolución para graves (P6) | Sí |
| `note_rate` | Ataques por segundo de música que suena (P4) | Sí, continuidad de ruta (P3) |
| `loudness_lufs` | Sonoridad integrada EBU R128 de FFmpeg, en la misma decodificación (P4) | Sí, continuidad de ruta (P3) |
| `spectral_flatness` | Planitud espectral 100–5000 Hz de los fotogramas fuertes, ponderada por potencia (P4) | Sí, continuidad de ruta (P3) |
| `intro_cue` | Primer instante con energía sobre el percentil 35 | Sí (punto de entrada) |
| `outro_cue` | Primer límite de frase unos 64 golpes antes del último sonido | Sí (punto de salida) |
| `sections` | Etiquetas intro/build/drop/breakdown/body/outro por bloques de 8 compases; `level` es el nivel medio frente al de la propia canción | Sí, salida en outro/antes de breakdown y llegada al drop (P8) |
| `tempo_confidence` | Parte de golpes que encajan en la rejilla; ≤ 0,6 si el tempo deriva | Sí, dentro de `confidence` y como requisito independiente de beatmatch (P8) |
| `confidence` | `0,38 + 0,36·tempo_conf + min(0,2, margen_tonalidad/8)` | Sí |

### Cálculo de la transición (`plan_transition`)

```
ratio = bpm_sale / bpm_entra, llevado a la velocidad del ciclo común más cercano
        (m pulsos de la que sale = n de la que entra; 1:1, 2:1, 3:2, 4:3, 3:1, 4:1
        y sus inversos; el contrato antiguo solo pliega una octava)
tempo     = 1 − |1−ratio| / 0,08
armonía   = 1 − pasos_Camelot / 7 (±1 en el mismo modo o cambio relativo = un paso; sin tonalidad conocida 0.55)
confianza = mínimo de las dos canciones
score_base = 0.46·tempo + 0.32·armonía + 0.22·confianza
score      = score_base si hay alineación ejecutable (`bars` o `beats`); 0 si no
             (las entradas antiguas sin contrato métrico conservan score_base)
```

La puntuación conserva la escala de `adaptive` anterior para ordenar rutas y
elegir entre bass_swap y filter_blend; no decide un fallback (P12-b). La
técnica comprueba el periodo local, la velocidad y la métrica realmente
ejecutadas. Las tres técnicas de beatmatch requieren alineación
ejecutable durante todo el solapamiento, no solo BPM compatibles (P12-b):
`bars` con unos confirmados en ambas canciones y compases ejecutados iguales;
`beats` con pulso estable compartido (región con `pulse_confidence > 0,6`,
rejilla regular sin huecos y ambos cues en pulsos medidos). En `beats` el
compás estimado por el modelo solo se envía si coincide en las dos canciones;
no se promete.

**Ciclo común (decisión del usuario, 2026-10-26).** Leer una canción en
binario o en ternario es una elección de nivel: un 12/8 es un 4/4 con pulsos
ternarios y un 6/8 se lee como dos pulsos o como tres. La mezcla no depende
de esa lectura: busca la duración más corta que sea un número entero de
pulsos de ambas canciones (`cycle_beats` = [m, n], relaciones 2ᵃ·3ᵇ dentro del
8 % de velocidad) y la mantiene empezando en los dos unos. Ejemplos: 3 contra 4
pulsos al mismo pulso (unos juntos al empezar y cada 12 pulsos), 120 ↔ 180 BPM
(2 pulsos = 3), 90 ↔ 120 (3 = 4), 116 ↔ 176 a velocidad 0,9886, 6/8 a 80 ↔ 4/4
a 120. El cue solo se recoloca por `relocation_seconds`: compases enteros de la
que sale que son también ciclos enteros, para no separar los dos unos. Donde el
modelo no da ningún 1, los unos se cuentan en compases enteros desde el 1
medido más cercano del mismo pulso continuo (`projected_bar`): el cue y la
recolocación usan esos unos.

| Condición | Técnica | Compases solicitados |
| --- | --- | --- |
| Pulso fiable, score ≥ 0,72 y ajuste local ejecutable | bass_swap | 16 |
| Lo anterior, tonalidades iguales/vecinas/relativas y apertura/cola tranquilas medidas suficientemente largas, sin huecos ni deriva | long_blend | 32 |
| Pulso fiable y ajuste local ejecutable, score < 0,72 | filter_blend | 16 |
| No hay mezcla ejecutable, confianza ≥ 0,42, pulso fiable en ambas canciones y golpe saliente medido válido | echo_cut | 8 |
| Confianza ≥ 0,42 sin los requisitos anteriores | structural_fade | 8 |
| Resto | safe_fade | 8 |

El ajuste local no supera el 8 % (rango de pitch de un plato o CDJ; decisión
del usuario, 2026-10-26, antes 6 %) y debe acumular como máximo 5 ms de desfase
con los valores redondeados del contrato. Un score alto por tonalidad no puede
eludir esa comprobación. Cualquier ciclo común mantiene alineados todos los
niveles que comparten las dos canciones; medio/doble tempo es el caso 2:1.

- Solapamiento: compases × duración local medida del compás de la canción que
  sale, entre 4 y 48 s; sin compás se usa una reserva temporal y
  `overlap_bars = null`, con el mismo límite del 25 % de duración que los reproductores (mínimo
  1,5 s en archivos cortos). Las técnicas de corte o fundido se limitan a 8 compases.
- `out_cue` = `outro_cue` ajustado al downbeat más cercano dentro de su región.
  `in_cue` = `intro_cue` ajustado dentro de su región; no salta a otra ventana
  cuando el comienzo carece de medida. Son los puntos de reserva:
  P8 usa las secciones cuando caben en la ventana y puede acortar el solapamiento.
- Beatmatch solo con BPM conocido, `tempo_confidence > 0,6` y alineación
  `bars` o `beats` de ambos cues y del tramo completo. Las reservas declaran
  `none`, mantienen velocidad normal y su score de mezcla vale cero en el
  contrato métrico. La tonalidad no puede eludir la guarda.
- `playback_rate` = velocidad que iguala el ciclo común con los periodos medidos
  cerca de cada punto (n · periodo_entra / (m · periodo_sale)). Solo en
  bass_swap, long_blend y filter_blend, y solo si el cambio es ≤ 8 %. Si no, 1,0.

### Ejecución en el navegador

`stores/dj.ts`:

- De 65 a 45 s antes de `out_cue`: si la transición tiene `confidence < 0,35`,
  pide `dj-transition`, con una petición en vuelo y reintentos cada 2 s mientras
  siga pendiente o falle la red. Se detiene al obtener medida o comprometer la
  transición. Las respuestas tardías no cambian una mezcla comprometida.
- 45 s antes de `out_cue`: carga la siguiente canción en el segundo reproductor
  (`armTransition`).
- Transición con `confidence < 0,35`: se convierte en `safe_fade` de 6 s como
  máximo, la canción entrante empieza en 0:00. En una canción de 4 minutos el
  fundido empieza unos 24 s antes del final.
- Transición fiable: solapamiento limitado al 25 % de la duración. La salida no
  empieza antes de 90 s o del 60 % de la canción, lo que llegue antes. Si
  `out_cue` cae fuera de esa ventana se mueve compases enteros (`bars`, o
  `beats` con compás común enviado) o pulsos enteros (`beats` sin compás),
  dentro de la cobertura medida (`metricCuePlacement` en
  `ui_web/src/lib/djCue.ts` y `ProgramDjPlan.metricCuePlacement` en Android),
  no una cantidad cualquiera. Si no cabe, el beatmatch pasa a `structural_fade`.
- "Mezclar entre canciones" apagado: técnica `direct`, la siguiente empieza
  cuando termina el archivo.

`mixer.ts` y `graph.ts`:

- La canción entrante arranca en silencio hasta 4 s antes del punto de mezcla, a
  `playback_rate` (0,92–1,08, `preservesPitch` activado). Mientras está en
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
| `echo_cut` | Un golpe saliente medido, corregido por velocidad; realimentación 0,32 y envío de eco hasta 0,32 (P9) |
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

**Estado: cerrado en #377.** `ANALYSER_VERSION` 4. Cambios originales:

Actualización P12 (`2ca8ccf2`): se conservan las tolerancias sintéticas de
pulso, se revisa la selección de su unidad, se añade agrupación y subdivisión
local con abstenciones, y los clientes reciben el compás explícito. El
`out_period × 4` descrito abajo es histórico y solo sigue como compatibilidad
de planes antiguos; [P12](P12.md) documenta el funcionamiento y los errores
reales actuales. Las cifras de evaluación de #377 son históricas.

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

**Estado: cerrado en la web (PR #395).** Síntoma medido y oído el 2026-10-26
(«It's Not Right But It's Okay» → «Teardrops (Rules Remix)», web con
plataforma `other` y la página oculta a ratos): en el cue, la entrante estaba 11 ms
fuera de fase y `mixer.ts` la movió con un `seek` mientras sonaba. El `seek`
tardó 370 ms (`media.seeking` → `media.seeked` en la traza) y la dejó 115 ms
(−0,24 pulsos) detrás durante los 30 s de la mezcla; el usuario oyó los bombos
desdoblados. Antes del arreglo nada corregía la fase después del cue.

**Arreglo.** Durante una mezcla con beatmatch, cada tick compara la posición de
la entrante con la que le corresponde según la saliente y, si se aparta más que
la tolerancia del plan (5 ms), ajusta su `playbackRate` como un DJ con el pitch:
error/1 s, como mucho ±2 %, en pasos de 0,25 %; vuelve a la velocidad exacta del
plan al quedar dentro de la mitad de la tolerancia. En el cue solo se hace
`seek` si el error supera 100 ms, una vez y con la entrante en silencio; la
mezcla se abre cuando el `seek` termina y el pitch cierra lo que quede. Tests
en `ui_web/src/lib/audio.test.ts`.

Lo que sigue es el diagnóstico anterior al arreglo, por lectura de código.

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

**Qué pasaba (desde #385, antes de P3).** En la ruta v6 (`_build_music_set_route`, la que usa
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
- El antiguo `test_dj_plan_v6_does_not_steer_by_energy` fijaba que el orden no
  dependía del análisis; P3 cambia esa parte a propósito y conserva las guardas
  de selección y de apertura.
- Las magnitudes están en el análisis: `note_rate`, `loudness_lufs`,
  `spectral_flatness`, `bpm`. `loudness_lufs` puede ser `None` (silencio o
  menos de 400 ms); `note_rate` y `spectral_flatness` son 0 en silencio. Una
  canción sin analizar no tiene ninguna (P5: no puntuarla peor por eso).

**Estado: cerrado, implementación `0e62b0fb`, sobre `main` en `6bb1af5d`.**

- `_build_music_set_route` fija primero el conjunto (hasta 8 canciones), sin
  consultar ninguna medida para elegir sus miembros. La apertura conserva el
  peso de la fuente y el desempate por barajado; ahora también encarga su
  análisis si falta. No se añaden candidatas ni puentes en P3.
- `order_continuous_route` ordena ese conjunto de forma voraz. Para cada
  posición medida calcula la distancia a las restantes: diferencias de
  `note_rate`, `loudness_lufs`, `spectral_flatness` y `bpm`, divididas cada una
  por su desviación típica poblacional en el conjunto elegido. Añade el déficit
  de calidad respecto a la mejor transición de ese paso, dividido por la
  desviación típica de esas puntuaciones. Minimiza la suma de los cinco
  cuadrados, con coeficiente 1 para todos; no hay nuevos pesos ajustados a gusto.
  La puntuación de transición sigue siendo la de `plan_transition`.
- Las escalas de las cuatro magnitudes se mantienen durante toda la ruta. El
  tempo se lleva a la octava del pulso de la semilla (o de la primera medida
  disponible): 60, 120 y 240 BPM representan el mismo pulso. Las dimensiones
  constantes o incompletas se omiten para todas las candidatas; un cero medido
  sí cuenta. Los empates conservan el barajado.
- Una canción sin analizar conserva su posición. Después de ella tampoco se
  compara la transición hacia la siguiente: se mantiene el orden del barajado
  entre las medidas que quedan. Así no se inventa una mala nota para la canción
  fría, ni una canción descargada puede expulsarla del conjunto o retrasarla.
- Cada transición de la respuesta corresponde al predecesor que realmente
  queda delante, incluida la semilla o la apertura. Web y Android consumen el
  mismo contrato sin cambios de cliente. La ruta antigua sin fuentes, `dj-place`
  y `dj-repair` conservan su política existente de `order_route`.

**Validación.** `tests/test_dj_route_continuity.py` comprueba las cuatro
magnitudes por separado, tonalidad, igualdad de influencia al cambiar unidades
y permutar ejes, medio/doble tempo, ceros, datos ausentes, empates, canciones
frías y encadenado. `tests/test_discovery_save_route.py` comprueba el límite y
la selección independiente de la caché con más candidatas que posiciones,
apertura en la fuente reciente, determinismo y los mismos miembros en frío,
mixto y caliente. Incluye una prueba con WAVs sintéticos que pasa por FFmpeg,
la caché SQLite real y HTTP; la petición final no puede volver a decodificar.

**Medición de lectura, 2026-10-23.** Reproducible con
`python -I docs/dj/route_probe.py --cache ~/.cache/soundsible/dj/analysis.sqlite3`.
10 análisis vigentes, 1024 muestras de 8 canciones y semilla aleatoria 0; mismo
conjunto y misma canción de salida en las dos variantes. SHA-256 de las medidas:
`a7d3361172d784b6196619c0c942003986a17e172acf31623c94aa3e9a5f927d`.
Sin proveedores, descodificación, escritura de caché ni reproducción.

| Media por transición (CPU por ruta) | Barajado anterior | P3 |
| --- | ---: | ---: |
| Puntuación interna de transición | 0,383 | 0,484 |
| Transiciones de fallback | 82,0 % | 60,8 % |
| Salto de notas/s | 0,537 | 0,514 |
| Salto de LUFS | 2,162 | 2,048 |
| Salto de planitud | 0,0160 | 0,0142 |
| Salto de pulso en BPM (octava equivalente) | 18,66 | 10,20 |
| CPU por ruta de 8 canciones | 0,63 ms | 3,29 ms |

**Límites.** Diez análisis no representan una biblioteca completa; son una
comprobación de las medidas y del coste, no una evaluación de escucha. El orden
voraz no garantiza el óptimo global ni maximiza solo la puntuación de mezcla:
también preserva la continuidad. Con todo el conjunto frío, el orden sigue
siendo el barajado y se mantienen los fundidos conservadores; ampliar la
cobertura de análisis y añadir puentes corresponde a P5. No hay aceptación
física de audio web, iPhone o Android en esta entrega.

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

## P5. Pool analizado, previews y canciones puente

**Diagnóstico original (antes de `31f696bc`).**

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

**Estado: cerrado en `31f696bc`.** Implementación:

- **Conjunto independiente de la caché.** La semilla de sesión y segmento fija
  hasta 16 candidatas. Las primeras `limit` (máximo 8) siguen siendo los destinos
  originales, aunque estén frías; se preparan también las restantes como posibles
  puentes. La descarga y el análisis nunca deciden qué canciones entran en ese
  conjunto. Se conservan exclusiones, historial y fuentes explícitas.
- **Preparación en servidor.** `_dj_prepare_cohort` encarga el análisis local y
  la adquisición de previews por la misma cola de prefetch que la reproducción:
  una vía de descarga, deduplicación por vídeo, contexto de cuenta, refresco tras
  rechazo del CDN, límite LRU y prioridad de reproducción existentes. No espera
  a red ni a FFmpeg dentro de `dj-plan`. Caché desactivada: no descarga; los
  destinos siguen entrando con fundidos conservadores. La cola de análisis
  admite hasta 64 identidades pendientes, con dos trabajadores.
- **Publicación inmediata.** `CacheWriter.commit` encarga el análisis tras guardar
  bytes completos y validados, tanto si los pidió la web como Android o el pool.
  La firma de una preview usa tamaño y revisión del contenido. Su `mtime` es el
  reloj LRU, cambia al servir rangos y ya no invalida el análisis. Sustituir el
  contenido o remuxarlo sí lo invalida. `ANALYSER_VERSION` 8 renueva la caché;
  las medidas musicales de P1/P4/P6 no cambian.
- **Biblioteca entera.** `shared/dj_library.py` hace un recorrido serial de todas
  las cuentas, deduplica archivos compartidos y revalida cada cinco minutos.
  Un error de archivo no aborta el resto. Arranque y parada pertenecen al motor;
  no se crea una cola de trabajos del tamaño de la biblioteca.
- **Puentes medidos.** `shared/dj_pool.py`: solo si la semilla y **todo** el
  conjunto están analizados. Una candidata fría bloquea la inserción, aunque
  otra ya descargada sirva de puente. Se admite como máximo un puente por tramo,
  sin repetirlo ni retirar destinos, cuando sustituye una transición sin
  beatmatch por dos tramos cuyo ajuste real de velocidad mantiene el desfase
  acumulado dentro de la tolerancia del plan (5 ms), y mejora la peor puntuación de ambas
  frente al tramo directo. Se elige la mejor de esas puntuaciones; los empates
  siguen el barajado, sin nuevas notas ni pesos de gusto. Máximo: 16 canciones
  de ruta. Las fuentes del recomendador siguen siendo las explícitas y las
  canciones que realmente sonaron.
- **Refinado web/iPhone y Android.** Reintentos cada 2 s dentro de la ventana
  65–45 s, una petición en vuelo por tramo. Terminan al recibir una medida o al
  comprometer la transición; se mantienen las guardas de cuenta, sesión, cambios
  de ruta y respuestas tardías. Una medición pendiente o un fallo de red conserva
  el fundido seguro.
- **Contrato y observabilidad.** `analysis_coverage` en la respuesta y campos
  `analysis_candidates`, `analysis_ready`, `analysis_cohort`,
  `analysis_cohort_ready`, `bridges` en el registro. `cache_hit`/`cache_miss`
  siguen contando related, no análisis. La respuesta v6 lleva medidas resumidas;
  rejillas y secciones completas quedan en el servidor. Dieciséis rejillas de
  ocho minutos a 220 BPM más la semilla superarían 256 KiB, el límite nativo.

**Medición real reproducible (2026-10-23).**
`.venv/bin/python -I docs/dj/pool_probe.py --previews ~/.cache/soundsible/previews`
elige 16 previews con semilla 0 y escribe las medidas en un runtime temporal;
no cambia la biblioteca ni la caché personal. Con `--download` usa la resolución
normal y adquisiciones nuevas en ese runtime. No imprime identidades ni URLs.

| Recorrido de las 16 previews | Bytes de audio | Adquisición | Análisis: pared / CPU |
| --- | ---: | ---: | ---: |
| Archivos ya presentes, análisis frío | 78.863.763 (75,2 MiB) | — | 11,50 s / 8,36 s |
| Resolución + descarga real + análisis frío | 78.867.963 (75,2 MiB) | 59,74 s; mediana 3,39 s por preview | 10,69 s / 7,83 s |

Las 16 descargas y los 16 análisis terminaron. Mediana por archivo: 4,90 MB y
0,50 s de CPU. Se descargan archivos completos, no muestras recortadas. La
adquisición incluye resolución, transferencia, validación y remux; estas cifras
son de esta máquina y esta conexión, no una promesa de latencia general. El
límite de 16 evita descargar las 17–46 candidatas de una recarga típica.

**Validación.** Tests de pools idénticos fríos/calientes verifican la misma
apertura, destinos y conjunto preparado, con límite, exclusiones e historial;
una caché parcial no añade puentes. Tests de puentes comprueban ambas
transiciones, ausencia de duplicados y conservación de destinos. AAC real →
commit de preview → análisis → SQLite → HTTP medido, con lectura LRU y
sustitución del contenido. Biblioteca de varias cuentas, podcasts, archivos
rotos y parada. Web: peticiones pendientes y fallos de red, respuesta después de
comprometer la carga del segundo plato y suite browser4 completa. Android: política JVM de
reintentos y `DjRefinementTest` HTTP con motor, servicio y decodificadores reales
(dos respuestas pendientes y la tercera medida); ejecución nativa en los checks
de Android de la PR. No hay aceptación física de escucha en esta entrega.

**Límites.** Una recarga fría responde inmediatamente con el orden conservador;
el refinado mejora cada transición antes de cargar el segundo plato. Los puentes
se consideran en una planificación que encuentre el conjunto completo medido:
no se rehace una ruta ya cargada cuando acaba el trabajo en segundo plano. Si
una descarga falla de forma persistente o la caché no retiene todo el conjunto,
no hay puentes en esa recarga. No se penaliza ni se retira esa canción por ello.

---

## P6. Compatibilidad de tonalidad mal puntuada

**Qué pasaba.** `_harmonic_score` solo miraba la distancia entre
tónicas y usa el modo solo cuando la distancia es 0:

- La menor relativa (La menor ↔ Do mayor, distancia 3): 0,68. En la rueda Camelot
  es la combinación más compatible después de la idéntica.
- Do mayor ↔ Do menor (paralela): 0,82. En Camelot está a 3 posiciones.
- Quinta con distinto modo (Do mayor ↔ Sol menor): 0,86.

La detección (`_window_features`) usaba el espectro medio de toda la canción sin
compensar armónicos, con bins de 5,4 Hz, que no separan semitonos por debajo de
~130 Hz. Además comparaba los perfiles con un producto escalar sin centrar ni
normalizar: el perfil menor tiene mayor media y norma, y ganaba incluso con
cadencias mayores.

**Estado: cerrado en `af6521f1`.** `ANALYSER_VERSION` 7 invalida las medidas
anteriores. La planificación sigue en el servidor; web y Android reciben el
mismo contrato y la misma corrección a través de `dj-plan`, `dj-place`,
`dj-repair` y `dj-transition`.

- Compatibilidad: distancia mínima en el grafo de la
  [rueda Camelot oficial](https://mixedinkey.com/camelot-wheel/0/). Las aristas
  son ±1 posición en el mismo modo y cambio al relativo mayor/menor. Se
  normaliza por el diámetro del grafo (7): `1 − pasos / 7`. No hay una tabla de
  notas de gusto por intervalo. Misma tonalidad: 1; relativo o cuarta/quinta en
  el mismo modo: 6/7; Do mayor → Sol menor: 4/7; Do mayor → Do menor: 3/7.
  Tonalidad o modo ausente/desconocido: se conserva el neutral 0,55.
- Croma: FFT Hann de 16384 muestras (0,67 Hz a 11025 Hz), salto de media
  ventana, espectro medio entre 32,7 Hz (Do1) y 5 kHz. Bins plegados por clase
  de altura; bloques de 32 ventanas, sin matriz espectral de toda la canción.
  Resuelve las notas graves en lugar de descartarlas. No añade dependencias.
- Detector: correlación de Pearson, como el
  [algoritmo Krumhansl–Schmuckler](https://extras.humdrum.org/man/keycor/), con
  los perfiles publicados que ya había, centrados y normalizados. `key_margin`
  es ahora la diferencia de correlación entre los dos primeros. Un silencio
  queda sin tonalidad; antes devolvía Si menor por el desempate.
- Las constantes de resolución se validan con cadencias sintéticas de respuesta
  conocida, sin notas humanas ni ajustes con música de la biblioteca. No cambia
  el seguidor de golpes de P1 ni la ejecución de las mezclas.

**Medición reproducible.** `python -I docs/dj/key_probe.py --reference 956e5344`
compara el código de antes con el actual, sin escribir en la caché personal.
Cadencias I–IV–ii–V–I e i–iv–ii°–V–i, dos segundos por acorde, transpuestas a
las 24 tonalidades. Tonos puros y timbre de seis parciales de amplitud 1/h:

| Registro y timbre | Aciertos antes | Aciertos ahora |
| --- | ---: | ---: |
| Do3–Si3, tonos puros | 20/24 | 24/24 |
| Do1–Si1, tonos puros | 1/24 | 24/24 |
| Do3–Si3, seis parciales | 12/24 | 24/24 |
| Do1–Si1, seis parciales | 9/24 | 24/24 |

Además: 48/48 cadencias a ±20 cents. Los tests comprueban los 576 pares de
tonalidades contra un recorrido independiente del grafo, selección de ruta,
respuesta HTTP y elección de técnica, límites de memoria, decodificación PCM y
AAC y sustitución de la caché anterior. La fixture de puentes de `dj-repair`
usaba 100 → 113 → 128 BPM: ninguno de los dos tramos podía hacer beatmatch y
solo pasaba porque Do → Re se puntuaba mal. Se corrige a 100 → 106 → 112 BPM,
con dos tramos mezclables, sin cambiar el umbral de admisión de puentes.

**Música real (FFmpeg y análisis completo, sin caché).** Se midió después de
fijar las señales sintéticas. `key_probe.py --audio <archivo>` admite varios
archivos y `--reference` para repetir la comparación. No se sube el audio.

| Grabación de la biblioteca | Antes | Ahora | Referencia |
| --- | --- | --- | --- |
| Bach, BWV 578, flautas de pico graves | Re menor | Sol menor | Sol menor, título de la grabación |
| Mozart, K. 488, II. Adagio | Fa♯ menor | Fa♯ menor | Fa♯ menor, [catálogo Mozarteum](https://kv.mozarteum.at/en/work/concerto-in-a-5654) |
| Mozart, Sinfonía 25, I. Allegro con brio | Sol menor | Sol menor | Sol menor, título de la grabación |
| Bach, BWV 1052, I. Allegro, Bob van Asperen | Do♯ menor | Sol♯ menor | Re menor en el título; afinación de la grabación no verificada |

**Límites.** El clavecín no se cuenta como acierto: sigue habiendo ambigüedad
entre tónica y dominante, y el análisis no verifica la afinación histórica ni
compensa los armónicos de cada instrumento. Tampoco modela modulaciones,
tonalidades distintas en la entrada y salida o material atonal; conserva una
estimación por ventana. Los 96 aciertos sintéticos no son una tasa de acierto
general sobre música real. No se han retocado los perfiles para estos ejemplos.

Coste medido: +22 ms de CPU al analizar ocho minutos de PCM, con memoria pico
equivalente; método y reproducción en `docs/PERFORMANCE.md`, *Tonality analyser*.

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

**Estado: cerrado en `d678f625`, opción (b).** La petición de implementar el
siguiente P aplica la mezcla automática a cada par, sin recuperar menús de estilo.

- **Una sola política.** Retirados `DJ_PROFILES`, `_PROFILE_POLICY`, el argumento
  `profile` de los planificadores, `DjProfile`, `DJ_PROFILE` y
  `ProgramDjPlanner.PROFILE`. Ningún cliente envía `dj_profile`; el servidor lo
  ignora si lo manda un cliente antiguo, incluso con un valor desconocido.
  Se conservan las escalas, umbrales y límites de ejecución de la política
  anterior; no se calibran nuevas notas con canciones ni se añade azar.
- **Técnica ejecutable.** Se construye el plan a sus puntos reales y se verifica
  el ajuste local dentro del límite de velocidad (6 % entonces; 8 % desde
  P12-b) y del presupuesto de fase de 5 ms. Si no cabe,
  no se etiqueta como beatmatch a velocidad 1: se vuelve a planificar un eco
  de ocho compases con golpe saliente medido, o un fundido estructural/seguro
  si no hay pulso o confianza suficientes. No cambia la sincronización de P9.
- **Mezcla larga medible.** Reutiliza los 32 compases y el máximo de 48 s que ya
  ejecutan los clientes. Requiere tonalidades iguales, vecinas en Camelot o
  relativas, y más solapamiento que la mezcla ordinaria. La apertura intro y
  la cola outro pueden prolongarse solo por bloques breakdown contiguos: el
  detector etiqueta intro/outro en un único bloque de ocho compases. Body,
  build, drop o un hueco interrumpen esa región. Ambas rejillas deben cubrir
  todo el tramo; cada una dispone de la mitad de los 5 ms para desviarse de su
  periodo local. No se extiende una mezcla atravesando una ventana sin medir.
- **Todos los caminos.** Ruta de fuentes explícitas, ruta legacy, puentes,
  peticiones, reparación y refinado usan el mismo planificador. Se retira
  `automation` de respuesta, vectores y tipos (cierre de P10); los reproductores
  siguen ejecutando `technique`. No cambian medidas ni caché del analizador.

**Validación reproducible.**
`PYTHONPATH=. .venv/bin/pytest -q -s tests/test_discovery_save_route.py -k 'measured_audio_sections or measured_aac_echo'`
genera señales conocidas, codifica AAC, analiza y persiste en SQLite. La mezcla
larga usa una apertura tranquila hasta 64,25 s y una cola tranquila desde
176,25 s, con cuerpo de nivel superior entre ellas: el detector produce los
bloques contiguos que permiten un solapamiento de 48 s. La planificación de
fuentes, legacy, colocación, reparación y refinado devuelven el mismo plan,
con y sin cada perfil antiguo. Las pruebas aíslan por runtime el contador HTTP
en memoria: la matriz no consume el presupuesto de pruebas posteriores. Los
casos de eco a 90 y 137 BPM contra 120 BPM
lo eligen automáticamente en ambas rutas y en el refinado.

`tests/test_dj_automatic.py` cubre las seis técnicas, medio/doble tempo,
periodo local distinto del BPM global, ausencia de secciones, apertura corta,
huecos entre secciones, body/drop, hueco de rejilla, deriva local, tonalidad ausente/distante y
archivo corto. El nuevo vector largo de `dj_structural_plans.json` y los cinco
vectores de eco son ejecutados por las stores web y `ProgramDjPlanTest` en
Android sin mover puntos, acortar el tramo ni retirar efectos. Se mantienen
las pruebas PCM nativas y de impulsos Web Audio real de P9. La regresión de
navegador es completa en los cuatro perfiles; build, lint y emuladores Android
se comprueban en los checks de la PR.

**Límites.** No hay aceptación física de escucha. Las secciones conservan la
heurística de ocho compases y los límites del analizador: sin evidencia de
apertura/cola suficiente no se elige mezcla larga. No hay nuevo arco de
energía, estilo, gusto escrito a mano ni corrección de velocidad durante la
reproducción (P2 sigue aparcado).

## P8. Secciones medidas y no usadas

**Diagnóstico original.** `_sections_from_features` etiqueta bloques de 8 compases (intro,
build, drop, breakdown, body, outro), pero nadie lee las etiquetas. `outro_cue`
solo usa los límites de frase; `intro_cue` es el primer instante con sonido.
`loudness_db` se eliminó en P4 (lo sustituye `loudness_lufs`); `tempo_confidence` solo entra en `confidence`.

**Estado: cerrado en `90b6c7e9`.** Solo cambia la planificación, no las medidas
guardadas ni su formato; no hizo falta invalidar la caché en P8. P12 consume
las agrupaciones conocidas por región e invalida sus medidas anteriores;
conserva el supuesto de ocho compases para frases y etiquetas. P13 revisará
su detección, y una región sin compás/1 no fabrica estructura de otra ventana.

- **Salida por secciones.** `plan_transition` lee los comienzos de outro y
  breakdown. Puede comenzar la mezcla en el outro o terminarla al llegar a un
  breakdown. Elige la oportunidad válida más cercana al punto de salida
  anterior; los bloques contiguos con la misma etiqueta forman una sola
  sección. No añade notas humanas ni pesos de gusto. Un outro corto reduce
  el solapamiento para dejar los 1,5 s de margen del servidor.
- **Entrada al drop.** Con pulso fiable, busca el primer drop que admita una
  entrada medida y la frase saliente más lejana dentro del solapamiento máximo.
  El final de esa frase y el drop coinciden en el reloj de reproducción con
  tolerancia de 5 ms. La velocidad se calcula cerca de los puntos elegidos y se
  comprueba con el redondeo que ejecutan los clientes. No se permite empezar
  antes del intro ni saltar más del primer cuarto de la canción entrante.
  Si no encajan frases, rejillas o límite de velocidad, conserva el intro.
- **Ventana ejecutable.** El servidor aplica antes el límite del 25 % del archivo
  y la salida no anterior a `min(90 s, 60 % de duración)`, como web y Android.
  Así los clientes no acortan después una mezcla que estaba alineada al drop.
  `overlap_bars` describe ahora el solapamiento efectivo.
- **Pulso independiente de tonalidad.** BPM ausente o `tempo_confidence ≤ 0,6`
  impiden bass_swap, filter_blend y long_blend: se usa fundido estructural o
  seguro a velocidad normal. El 0,6 es el techo que ya tiene la rejilla local
  en P1 (`(0,7 − 0,4) / 0,5`), no una nota nueva ajustada con canciones.
- **Mismo contrato.** Todas las rutas y el refinado usan `plan_transition`.
  El servidor conserva secciones y rejillas; v6 continúa enviando resúmenes
  compactos y el plan final. Web y Android no interpretan etiquetas musicales.

**Medición reproducible (2026-10-24).**
`PYTHONPATH=. .venv/bin/pytest -q -s tests/test_discovery_save_route.py -k measured_audio_sections`
genera canciones de cuatro minutos con golpes a 120 BPM y regiones de ocho
compases de nivel conocido, codifica AAC con FFmpeg, analiza, guarda en SQLite
y pide `dj-plan` y `dj-transition`. Los dos endpoints dan el mismo plan:

| Caso medido | Salida | Entrada | Solapamiento | Velocidad |
| --- | ---: | ---: | ---: | ---: |
| Breakdown en 208,25 s, drop entrante en 64,25 s | 176,2499 s | 32,2498 s | 32 s | 0,999998 |
| Outro en 224,25 s, sin frase posterior que quepa | 224,2499 s | 0,2498 s | 14,25 s | 1 |

El primer caso hace coincidir drop y breakdown dentro de 5 ms; el segundo
conserva el intro y termina antes de agotar el archivo. Las pruebas de rejilla
con deriva sintética también comprueban el fundido sin beatmatch.
La cota de final usa la duración realmente decodificada y la precisión de
serialización de 1 ms: AAC puede conservar muestras adicionales respecto a los
240 s nominales de la señal (observado en el decodificador de CI).
`shared/contracts/dj_structural_plans.json` fija cuatro vectores comunes
(120→125 BPM con drop, outro corto, pulso no fiable y archivo de 90 s): Python
comprueba el plan y las suites web y JVM de Android lo ejecutan sin mover
puntos ni acortar el solapamiento. No hay escucha física en esta entrega.

**Límites.** Se conservan las etiquetas heurísticas de ocho compases y los
límites de detección de P1; estas señales no prueban la clasificación de todos
los géneros. No se inventan secciones en el hueco central de los archivos largos
analizados por ventanas. Sin sección utilizable se mantienen los puntos de
reserva; sin una rejilla fiable se funde sin beatmatch. No se añade corrección
de velocidad durante la reproducción (P2 sigue aparcado).

## P9. Eco no sincronizado con el tempo

**Diagnóstico original.** `ensureEcho` usaba 280 ms con cualquier BPM; Android
repetía ese retardo fijo en `ProgramDeckEffects`. Cambiar solo el `delayTime`
por un golpe tampoco bastaba: en Chromium y WebKit el bucle de realimentación
añade un bloque de 128 muestras en cada vuelta posterior a la primera.

**Estado: sincronización cerrada en `a8a22618`.** El contrato HTTP
existente permite `echo_cut` con los perfiles `cuts_drops` y `open_format`.
En aquella entrega la ruta explícita y ambos clientes usaban `adaptive`, sin
eco; la activación automática posterior está cerrada en P7 (`d678f625`).
No se añade un selector ni se cambia la política de técnicas para cerrar P9.

- **Retardo medido.** `plan_transition` incluye `echo_delay_seconds`: un golpe
  de la canción saliente, medido cerca del punto de salida y durante el tramo
  mezclado. No usa el tempo entrante ni inventa un periodo a partir de
  `bar_seconds`. Requiere audio analizado, rejilla, BPM conocido y
  `tempo_confidence > 0,6`; sin ello sustituye el eco por `structural_fade`.
  Solo cambia el plan: no se modifican medidas ni la versión de su caché.
- **Web.** Store → plan ejecutable → mezclador → grafo conserva el retardo y
  lo divide por la velocidad real del plato saliente. El grafo resta un bloque
  del retardo del bucle y lo añade antes de la primera entrada: tanto el primer
  eco como los siguientes caen en el golpe. La ruta del eco fija dos canales
  para que la negociación del bucle no cancele estéreo en oposición de fase.
  Al retirarlo desconecta también la entrada del efecto.
- **Android.** El mismo campo pasa por `ProgramDjPlanner`, `ProgramDjPlan`,
  `ProgramDjSession` y `ProgramMixOutput` hasta el búfer PCM. Se ajusta a la
  velocidad saliente y se redondea a la muestra más próxima de la salida.
  El búfer se prepara fuera del bucle de muestras, solo para eco y con un
  máximo de dos segundos. Cambiar el retardo o reiniciar el plato vacía la
  cola anterior. La exportación de sesión conserva el campo.
- **Reserva y niveles.** Plan antiguo sin retardo, valor inválido, origen
  distinto, poca confianza o mezcla apagada: no se inventan 280 ms. El eco sigue
  tomando la señal nivelada antes del fundido; se conservan realimentación
  0,32 y la curva de envío existentes. No se ajustan valores de gusto.

**Medición reproducible (2026-10-24).**
`PYTHONPATH=. .venv/bin/pytest -q -s tests/test_discovery_save_route.py -k measured_aac_echo`
genera música sintética de pulso conocido, codifica AAC, analiza, guarda en
SQLite y pide `dj-plan` legacy y `dj-transition` con `cuts_drops`. Los dos
endpoints entregan el mismo plan:

| BPM de la señal saliente | Periodo esperado | Retardo HTTP |
| --- | ---: | ---: |
| 90 | 0,666667 s | 0,666668 s |
| 137 | 0,437956 s | 0,437956 s |

`shared/contracts/dj_echo_plans.json` fija cinco casos: 55, 90, 120, 137 y
220 BPM frente a una entrada de 173 BPM. Las stores web conservan el campo.
`dj-echo.spec.ts` ejecuta el grafo real con impulsos estéreo de polaridad opuesta
en Chromium y WebKit: 44,1/48 kHz, velocidades 1/1,04 y tres repeticiones por
caso, 60 repeticiones por perfil. Comprueba posición y amplitud de cada canal;
el error máximo observado es una muestra. La tolerancia es tres muestras
(0,068 ms a 44,1 kHz), muy por debajo de los 5 ms del plan. `ProgramDeckEffectsTest` ejecuta los mismos periodos en PCM nativo y
comprueba las tres repeticiones, nivelación, realimentación y vaciado de cola.
`ProgramDjPlanTest` comprueba confianza, pertenencia, mezcla apagada y valores
ausentes o inválidos. `ProgramMixOutputTest` conserva eco con decodificadores y
salida reales, con periodo explícito de 0,5 s, en los checks de Android.

**Límites.** Sin escucha física en esta entrega. Un periodo constante no sigue
rubato: el eco no se aplica con pulso no fiable. La compensación web corresponde
al bloque de 128 muestras de los contextos predeterminados verificados en los
dos motores. P9 por sí sola no habilitó eco automático ni retiró perfiles o
`automation`: esos cambios posteriores están cerrados en P7 y P10 (`d678f625`).

## P10. Código muerto y documentación desactualizada

Hecho en #385: `api.interpretDjCommand`, `/api/discovery/music/dj-command`,
`_dj_command_direction`, `setAutoDjProfile`, `setAutoDirection`,
`setAutoProfile` (sin llamadores; además pedía claves `autoMode.note.crate.*`
que no existían), 76 claves de texto de `autoMode` sin uso en los cuatro
idiomas, "DJ style" en `docs/AUTO_MODE.md`, "recency decay" y "energy arc" en
`docs/ARCHITECTURE.md` y `docs/PLAYBACK_QUEUE_CONTRACT.md`, y el "orders songs by
tempo, key and energy" de `README.md`.

**Estado: cerrado en `d678f625` junto con P7 (b).** Retirado `automation` de
`plan_transition`, los vectores compartidos y los tipos web; ningún reproductor
lo leía y ambos siguen ejecutando `technique`. La documentación de usuario y
las secciones de funcionamiento de este handoff describen la política vigente.

---

## Segunda fase: responsabilidades y estructura musical (2026-10-25)

**Decisión del usuario:** añadir el rewrite por responsabilidades y resolver
la identificación del compás y del pulso 1, teniendo en cuenta sus dependencias
con las frases, las secciones, la ordenación y los reproductores. El diagnóstico
de partida se conserva como histórico; los cierres vigentes están en la tabla
y en cada punto. Orden: **P11 → P12 → P13**, un punto por sesión salvo
indicación del usuario.

### Diagnóstico de partida: comprobaciones y suposiciones históricas

En `ad59b838` no hay otro pipeline que detecte el compás binario o ternario:

- `_tempo_lag` contiene el comentario «Binary metre» y refuerza la
  autocorrelación a uno, dos y cuatro periodos. Es una suposición del detector
  de tempo, no un clasificador de compás o subdivisión.
- `_downbeat_phase` elige entre cuatro posiciones por cambio armónico y fuerza
  del ataque. Devuelve una posición, sin confianza específica ni posibilidad
  de abstenerse ante un empate o una señal ambigua.
- `_compose` toma uno de cada cuatro pulsos como inicio de compás y fija
  `bar_seconds = period * 4`. El contrato no expresa los pulsos por compás ni
  la subdivisión de cada pulso.
- `phrase_boundaries` parte de uno de cada ocho inicios de compás.
  `_sections_from_features` también divide en bloques de ocho compases y los
  etiqueta por sus medidas de nivel y movimiento. Frases y secciones comparten
  esa base heurística: no son dos detecciones independientes que confirmen el 1.
- `confidence` combina confianza de tempo y margen de tonalidad. No mide la
  certeza del compás, del 1 o de la frase. Un pulso muy regular no garantiza
  ninguno de los otros tres.
- La web (`planBarSeconds`, `djCue.ts`) y Android
  (`ProgramDjPlan.resolve`) reconstruyen el compás como cuatro periodos del
  pulso saliente. Cambiar solo el detector del servidor dejaría esta suposición
  activa en ambos clientes.

Separar conceptos musicales: **pulso**, **pulsos por compás**, **subdivisión del
pulso**, **inicio de compás**, **inicio de frase** y **sección**. Por ejemplo,
3/4 tiene tres pulsos de negra; 6/8 puede organizarse en dos pulsos de negra con
puntillo, cada uno subdividido en tres. Una etiqueta «ternario» no distingue
esos casos. Medio/doble tempo tampoco es una detección de compás: cambiar la
unidad del pulso cambia cuántos pulsos describen un mismo compás.

**Diagnóstico sintético puntual de esta revisión.** PCM mono a 11025 Hz,
48 segundos, pulsos cada 0,5 s desde 0,25 s; bombo en todos los pulsos, acento
y cambio de acorde cada tres o cuatro. Se ejecutó `_compose` directamente en
memoria y después `plan_transition`; sin FFmpeg, caché, HTTP ni reproducción.
Coincidencia del 1: distancia inferior a 10 ms respecto al inicio conocido.

| Compás de la señal | BPM detectado | `tempo_confidence` | Compás real | `bar_seconds` | Unos detectados que coinciden con el real |
| --- | ---: | ---: | ---: | ---: | ---: |
| 3/4 | 120,001 | 1 | 1,5 s | 2 s | 8/24 |
| 4/4 | 120,001 | 1 | 2 s | 2 s | 24/24 |

El par 3/4 → 4/4 produjo `bass_swap`, `playback_rate = 1`, confianza 0,763 y
`fallback = false`. Verifica la falta de una comprobación métrica; no demuestra
que una mezcla entre compases distintos sea siempre imposible ni determina
qué técnica debe usarse en cada caso. No es una tasa de acierto sobre música
real, una prueba permanente ni una aceptación física. P12 debe convertir el
caso y sus variantes en fixtures reproducibles con respuesta conocida.

### Relaciones entre los puntos anteriores que deben quedar explícitas

- **Tempo y orden:** `plan_transition.score` ya contiene tempo; P3 vuelve a
  incluir BPM entre sus dimensiones de continuidad. Hay influencia por dos
  caminos. No basta para declararlo un fallo: documentar qué objetivo cumple
  cada camino y comprobar si el efecto conjunto es el decidido, sin nuevos
  pesos ajustados a gusto.
- **Políticas de ruta:** la ruta de fuentes usa `order_continuous_route`;
  la ruta legacy y partes de peticiones/reparación usan `order_route`, que
  combina transición, semántica y relevancia. Todos llaman a `plan_transition`,
  pero compartir ese cálculo no hace iguales sus objetivos de ordenación.
- **Validez de la mezcla:** el cálculo de relaciones de medio/doble tempo y
  de deriva ejecutada aparece en planificación, entrada al drop y admisión de
  puentes (`dj_pool._beatmatched`). Debe haber una definición coherente de
  pulso comparable y mezcla ejecutable, no variantes que diverjan al cambiar
  el modelo rítmico.
- **Frases y secciones:** un 1 incorrecto puede desplazar ambas y sus cues.
  P8 consume las etiquetas existentes; P13 revisará su detección y sus límites.
- **Análisis de audio:** ritmo, ataques de notas, tonalidad y textura usan
  ventanas y resoluciones diferentes por necesidades distintas. No fusionar
  sus FFT o detectores solo porque todos parten del mismo PCM. Compartir
  trabajo exige demostrar equivalencia de medidas y beneficio de coste.

## P11. Rewrite por responsabilidades, contratos y coherencia de políticas

**Estado: cerrado, implementación `67d086cf`.** Separadas las responsabilidades
y sus contratos sin cambiar resultados musicales ni el formato de caché.
Mapa, unidades, dependencias, políticas y evidencia reproducible en
[ARCHITECTURE](ARCHITECTURE.md). P12 se implementó después en `2ca8ccf2`;
el siguiente trabajo vigente es P12-a, la comparativa acordada con el usuario.

- `shared/dj_engine.py` queda como fachada pública. `shared/dj/` separa modelos,
  almacenamiento/adquisición, ritmo, medidas por ventana, composición, estructura,
  reglas temporales, transiciones y rutas. SQLite y los trabajos tienen un único
  propietario. Los módulos puros no cargan almacenamiento ni Flask.
- Las búsquedas de peticiones, huecos y reparación se extraen de los endpoints.
  Se centralizan equivalencia de tempo, periodo local y deriva ejecutada,
  conservando las dos políticas de ruta y las guardas de web y Android.
- `Analysis`, `AnalysisSummary`, `WindowFeatures`, `RhythmWindow`, `Structure` y
  `TransitionPlan` distinguen medidas completas, resumen y ejecución. Conservan
  segundos, BPM, ratio de reproducción, datos ausentes y ceros medidos. No se
  rellena el hueco central entre ventanas ni se invalida la caché.
- `python -I docs/dj/extraction_probe.py --reference ad59b838`: igualdad completa
  de 7 análisis PCM, 784 planes, 168 rutas, WAV/AAC y cuatro lecturas de caché
  sin decodificar, en ambos sentidos. Los vectores comunes no cambian.
  `key_probe.py` mantiene 96/96 cadencias, antes y después; también puede cargar
  una revisión posterior a la separación sin importar por error el código actual.
  Los benchmarks de análisis y cola migran sus puntos privados al propietario;
  se ejecutan extracción (18/480 s), pipeline WAV (18/900 s), HTTP con dos
  análisis y los cuatro escenarios de cola con/sin instrumentación. Es una
  comprobación funcional de las herramientas, no una mejora de coste medida.
- Regresión local: 2.287 tests del motor aprobados, uno omitido y cobertura
  77,30 %; 1.762 tests de UI. Tras cerrar la extracción, 74 casos dirigidos
  incluyen las 13 pruebas de fronteras, adquisición acotada y gevent. Los checks
  de la PR cubren el conjunto final y los ejecutores web/Android. Sin aceptación
  física de escucha; no se afirma una mejora de coste ni detección métrica nueva.

### P11-a. Discrepancia conservada: puentes de petición basados solo en score

**Resuelto para medidas métricas en P12; pendiente para entradas legacy.**
P12 comparte `beatmatch_fits` con los puentes de fuentes y exige ejecución
válida en cada tramo de petición/colocación/reparación, incluido el final. La
fixture histórica sin `metric_regions` conserva la diferencia siguiente;
revisar esa compatibilidad y la comparación de técnicas de reserva sigue
pendiente, sin bloquear el cierre de P11 ni el modelo métrico de P12.

Antes de P12, `route_to_request` declara mejorar la seguridad pero no exige ejecución de
beatmatch. Con medidas de 100 → 109 → 119 BPM y tonalidades Do → La → Fa#
mayor elige un puente con dos `echo_cut` a velocidad 1, puntuaciones
0,381/0,381 frente a 0,244 del paso directo. Los dos ajustes exceden el límite
del 8 %; el puente gana solo por tonalidad. Hasta P12-b, con el límite del 6 %,
la fixture era 100 → 107 → 114 BPM (0,602/0,625). Con el mismo conjunto,
`add_measured_bridges` no añade puente porque
requiere dos tramos con beatmatch y deriva admisible. La fixture permanente es
`test_preserved_request_bridge_policy_differs_from_measured_cohort_admission`.

Revisar esa condición en peticiones legacy, colocación y reparación, y decidir
cómo comparar la seguridad de técnicas de reserva frente a `score`. No basta
con usar el mismo planificador para considerar iguales los objetivos de ruta.
La doble influencia del tempo (compatibilidad global del par y continuidad de
BPM) también queda inventariada, sin nuevos pesos ni recalibración. La secuencia
acordada continúa con P12-a; P11-a queda visible para esas entradas anteriores.

### Alcance

El diagnóstico de partida: `shared/dj_engine.py` reunía unas 1800 líneas de SQLite, trabajos en segundo
plano, FFmpeg, DSP, composición del análisis, planificación y rutas. Además,
`auto_mode.py` orquesta fuentes y endpoints, y los clientes poseen guardas de
ejecución. Definir módulos con estas responsabilidades; los nombres y la
distribución concreta de archivos se deciden al implementarlo:

| Responsabilidad | Produce / posee | No debe decidir |
| --- | --- | --- |
| Modelos y contratos | Medidas, cobertura temporal, unidades, ausencia de evidencia y plan ejecutable | Acceso a disco, proveedores o reproducción |
| Almacenamiento y adquisición del análisis | Identidad, versión, SQLite, decodificación y trabajos acotados | Orden musical o técnica de mezcla |
| Análisis musical | Ritmo, tonalidad, densidad de notas, sonoridad y textura por ventanas medidas | Fuentes, candidatos elegidos o controles del reproductor |
| Estructura musical | Compases recibidos del análisis rítmico, frases, secciones y cues candidatos | Inventar un nuevo pulso o elegir canciones |
| Transiciones | Compatibilidad del par, técnica, cues, velocidad, efectos y comprobación de ejecución | Adquirir música o modificar la sesión |
| Rutas y puentes | Orden dentro del conjunto elegido y evaluación de sus transiciones | Redefinir las medidas o la validez de beatmatch |
| Adaptadores HTTP y reproductores | Orquestación de sesión, contrato compacto y ejecución en cada plataforma | Volver a inferir compás o estructura musical |

- Definir tipos y unidades explícitas en las fronteras, separando análisis
  completo, resumen para clientes y plan de transición. Distinguir ausente,
  desconocido y cero medido. Mantener cobertura por ventanas: no interpolar
  el hueco central no analizado de grabaciones largas.
- Centralizar las operaciones repetidas de equivalencia de tempo y de
  validación del plan, conservando su resultado actual. Mantener una frontera
  de validación al admitir puentes y al ejecutar; compartir la definición no
  significa confiar ciegamente en un plan incompleto o antiguo.
- Inventariar la política de cada entrada: planificación de fuentes, legacy,
  peticiones, colocación, reparación y refinado. Registrar qué criterios son
  comunes y qué diferencias son deliberadas. Revisar la doble influencia del
  tempo y el uso de `score` frente a la técnica realmente ejecutable.
- Conservar en esta extracción los resultados musicales y las diferencias de
  política existentes. Si el inventario confirma una contradicción que exige
  cambiar resultados, dejar un subpunto concreto y su evidencia en este handoff
  antes de cerrar P11; no ocultarla como un cambio de organización.
- Mantener las fronteras públicas y los puntos de inyección usados por las
  pruebas, o migrar sus consumidores en la misma entrega. Evitar dependencias
  circulares, estado global duplicado y accesos a SQLite desde el módulo puro.
- El servidor sigue siendo dueño del plan musical; web y Android conservan
  sus ejecutores apropiados. No incorporar las stores web al audio Android.

### Criterios de cierre

- Mapa de módulos y dependencias documentado, con propietario único para cada
  medida y regla compartida. Los endpoints no contienen un segundo planificador.
- Comparación antes/después sobre las mismas fixtures y análisis: mismas
  medidas, caché compatible, mismos órdenes y planes, con los mismos límites
  de redondeo, velocidad, fase y solapamiento. No regenerar expectativas para
  hacer pasar una extracción que cambia comportamiento.
- Mantener los vectores comunes de servidor, web y Android, las pruebas AAC →
  SQLite → HTTP existentes y los casos fríos/calientes y de sesión externa.
  Ejecutar las suites pertinentes al alcance real, incluida la regresión de
  navegador completa si se toca `ui_web/`, según `AGENTS.md`.
- Verificar que se mantienen decodificación única, memoria y concurrencia
  acotadas, trabajo DSP fuera del bucle cooperativo y respuestas compactas.
- Inventario de diferencias de políticas resuelto o con subpuntos explícitos;
  actualizar la tabla y dejar P12 como siguiente trabajo. Una extracción sin
  cambios de medidas no invalida la caché; si cambian, aplicar su versionado.

## P12. Compás, subdivisión, identificación del 1 y sus confianzas

**Estado: cerrado con P12-b (2026-10-26).** #394 (`2ca8ccf2`) aportó contratos
y guardas, pero su detector no acreditó compás ni 1 en música real y empeoró el
tempo en `main`. P12-a comparó alternativas abiertas y el usuario eligió
Beat This! `final0`. P12-b lo integra: pulsos y unos del modelo (ONNX Runtime,
DBN en NumPy), rejilla fijada a los ataques como en P1 y dos garantías de
mezcla, `beats` y `bars`. Evidencia en
[detector_comparison/RESULTS](detector_comparison/RESULTS.md) (sección P12-b) y
en [P12](P12.md). P2 sigue aparcado; no se cambia el reloj ni se introduce
corrección continua de velocidad.

Límites vigentes tras P12-b:

- La lectura del compás puede no ser la escrita: el DBN agrupa en 3 o 4
  pulsos y elige el nivel de pulso (en las señales de dos pulsos ternarios lee
  180 BPM binarios donde se generaron 120 ternarios). El ciclo común hace que
  la mezcla sea la misma con cualquier lectura. Lo que sí depende de ella es
  el recuento de frases y secciones (P13). En las señales sintéticas de 3/4
  el modelo agrupa de 4 en 4 (en valses reales, vistos en su entrenamiento,
  acierta); la confirmación independiente no lo promete, pero el 1 estimado
  puede caer en otro pulso del compás.
- La confirmación independiente no aparece en la música real medida (0 % en
  GTZAN y Ballroom): en la práctica, las mezclas con música real son `beats`.
- Sin anotaciones de la biblioteca del usuario, la comparación v8/v9/v10 de
  una muestra solo mide concordancia (sección P12-b de RESULTS).
- Sin aceptación física de escucha nueva.

Lo siguiente describe el contrato de #394, que P12-b conserva:

- `metric_regions` distingue periodo/unidad, pulsos por compás, subdivisión,
  cobertura y confianzas de pulso, agrupación, subdivisión y 1. Desconocidos y
  cambios no se rellenan con 4/4. Las confianzas describen evidencia del modelo,
  no probabilidades calibradas de verdad musical.
- #394 contrastaba hipótesis binarias/ternarias de pulso; P12-b las retira
  (eran la causa de los errores 3:2 y 4:3). Las agrupaciones locales de 2/3/4/6
  pulsos quedan como confirmación independiente de los compases del modelo.
  Las fixtures incluyen anacrusas, 1 débil, contratiempos, dos subdivisiones
  presentes, cambios dentro/fuera de un bloque, deriva, tono, pulso uniforme y
  unos del modelo equivocados de fase o de agrupación.
- El plan certifica `alignment: bars` solo con ambos cues y todo el tramo
  medidos, confirmados y ejecutables; 4 pulsos de 0,5 s y 2 de 1 s sí pueden
  compartir compases de 2 s. Desde P12-b, igual pulso en 3/4 → 4/4 da `beats`:
  pulso alineado, sin prometer los unos. Score cero y reserva explícita solo
  sin alineación ejecutable (`none`).
- Rutas, peticiones, colocación, reparación, refinado y puentes comparten esa
  regla. Web y Android leen el compás local, conservan cobertura al recolocar
  y degradan si no cabe. Once vectores comunes verifican ambos ejecutores
  (tres de `beats` desde P12-b); el contrato antiguo conserva su reserva, sin
  presentarla como medida.
- Caché invalidada y resumen compacto con valores nulos explícitos. AAC →
  SQLite → HTTP cubre filas anteriores, estado frío/caliente, una decodificación
  por archivo y todos los endpoints sin redetectar música en clientes.
- Evaluación real separada: doce fragmentos Ballroom, anotaciones fijadas y
  hashes de cada entrada. Ninguno acredita compás y 1 correctos; hay errores
  de unidad, agrupación y abstenciones. Se documentan sin calibrar sobre esas
  canciones ni convertir resultados sintéticos en precisión real. No hay
  aceptación física de escucha nueva.
- P8 consume ahora solo los compases conocidos de cada región, conservando
  el supuesto de ocho compases para frases/secciones. **P13 queda pendiente**:
  ni esas frases ni sus etiquetas prueban la forma musical.

Validación local de #394: suite principal de 2.330 casos (77,44 %), seguida de 201
casos dirigidos sobre los ajustes finales y tres casos AAC/HTTP de peticiones
(sueltas y de artista); 1.772 tests de UI y 23 pruebas JVM. Chromium completo
con un trabajador: 353 aprobados, 71 skips previstos; WebKit completo en imagen
Playwright y montaje de solo lectura: 344 aprobados, 80 skips previstos. Los
pases con concurrencia local tuvieron fallos intermitentes de navegación/carga
que no se repiten con la configuración de CI; no se han relajado expectativas.
Los checks de GitHub del último head de la PR completan la validación remota;
la aceptación física de escucha no queda sustituida por estos resultados.

### Continuación acordada: P12-a y P12-b

El usuario autoriza **probar y comparar** estimación conjunta de pulso/compás/1
y soluciones abiertas mantenibles, no solo Beat This!. **Con los resultados
sobre la mesa decidirá el usuario** qué integrar. Este acuerdo no elige una
librería ni autoriza saltar esa decisión por tener tests verdes.

El [plan operativo](DETECTOR_COMPARISON.md) fija el orden para avanzar rápido:

1. Congelar baselines, corpus/particiones y una frontera común de resultado;
   desarrollar un solo runner y adaptadores en archivos separados. Incluir
   el prototipo de seguimiento conjunto y las familias Beat This!, BeatNet,
   madmom/origen y fork moderno, Beat Transformer y All-In-One; Essentia y
   librosa sirven además como controles de pulso, sin atribuirles un detector
   de primer tiempo que no proporcionan. Revisar disponibilidad, pesos,
   licencias, dependencias y mantenimiento; registrar exclusiones con motivo.
2. Ejecutar todos los admitidos y sus variantes sobre las mismas señales y
   grabaciones. Separar errores de tempo/unidad, pulso, agrupación/subdivisión
   y 1; medir cobertura, abstenciones, falsas certezas, CPU/RAM, carga, disco
   y mantenibilidad. Declarar el solapamiento de entrenamiento por checkpoint:
   Ballroom ya visto no es un test independiente de todos esos modelos.
3. Llegar casi de extremo a extremo con el mismo adaptador hacia P12:
   AAC/WAV → backend → normalización → SQLite experimental → planificador,
   rutas y HTTP; contrastar los planes y ejecutores existentes. Conservar
   producción y dependencias de distribución estables durante la comparativa.
   No crear un detector, caché o interfaz de cliente por alternativa.
4. Presentar matriz por método/caso, resultados, costes y compromisos al
   usuario y esperar su decisión. P12-a no termina solo con un inventario ni
   con cifras copiadas de artículos. Tampoco selecciona un ganador con pesos
   manuales o convierte abstenerse siempre en detección resuelta.
5. Tras la elección, integrar una sola vía en P12-b y desarrollar P13 sobre
   ella. Preparar antes las fixtures de frases/secciones y registrar la salida
   estructural de los modelos que la tengan; no reescribir todavía estructura
   sobre una métrica que podría descartarse. Se permiten entregas amplias que
   cierren P12-b y P13 juntas si evitan pisar código y demuestran cada criterio.

### P12-b: plan de integración (2026-10-26)

**Ejecutado.** Diferencias respecto al plan: la rejilla toma el tiempo de cada
pulso del pico de activación entre tramas, pondera la recta por el ataque
medido y corrige fase y periodo con los ataques a ±20 ms (una trama del
modelo), no a ±35 ms: en `gtzan_rock_00001` la ventana de P1 saltaba a otro
instrumento. La sesión ONNX desactiva la telemetría 1DS de ONNX Runtime.

Prueba en la estación del usuario (2026-10-26, techno/house). Las
transiciones suenan mucho mejor, pero en una mezcla `beats` el 2 de la
entrante caía en el 1 de la saliente (medido por el usuario a mano y en las
trazas: +0,47 s, un pulso a 125 BPM, constante toda la mezcla). Dos causas,
corregidas con tests de regresión:

- El navegador no aplicaba al borde de la cobertura los 5 ms que admite el
  servidor; un solapamiento 0,9 ms más largo que lo medido hizo mover el cue.
- El paso de recolocación tomaba el compás del tramo entero; un bloque sin
  compás regular dentro del solapamiento lo reducía a un pulso. Ahora es el
  compás de la región del cue.

En la misma prueba: el DBN se salta pulsos en pasajes a medio tiempo, y la
pendiente inicial suponía pulsos consecutivos. Canciones estables quedaban
como «deriva» (confianza 0,34-0,49) y sin beatmatch. Se numeran los pulsos
a través de los saltos antes de ajustar (confianza 1,0 en esas canciones) y
`ANALYSER_VERSION` pasa a 11.

Una sola vía, con las decisiones de arriba. Una entrega coherente (servidor,
persistencia, endpoints, web, Android y empaquetado), apoyada en los contratos
y guardas de #394. Evidencia de partida en
[detector_comparison/RESULTS](detector_comparison/RESULTS.md).

1. **Runtime y pesos.** Sesión ONNX Runtime única y perezosa, un hilo,
   exportación con atención partida (`onnx_probe.py --sliced-attention`),
   frontend NumPy y troceado de Beat This!. `onnxruntime` entra en
   `requirements.txt`, el lock de Docker y el sidecar PyInstaller. El asset
   lleva SHA256; sin pesos válidos el análisis se abstiene, sin otro detector.
2. **DBN en NumPy.** Port del `DBNDownBeatTrackingProcessor` que usa Beat
   This! (3 y 4 pulsos, 55–215 BPM, 50 fps, λ 100, observación 16, umbral
   0,05, corrección a picos). Igualdad contra las salidas `beatthis-final0-dbn`
   retenidas, con fixtures de activaciones en los tests.
3. **Una decodificación.** FFmpeg a 22050 Hz con el medidor LUFS en la misma
   pasada; las medidas de 11025 Hz se derivan en NumPy. Comprobar P1/P4/P6
   con sus señales sintéticas; `ANALYSER_VERSION` sube.
4. **Rejilla.** El modelo decide tempo, octava, fase y el 1 candidato. El
   ajuste fino de P1 no puede mover un pulso a otro ataque: en la comparativa,
   el refinamiento local bajó el F1 sintético de 0,80 a 0,68 aunque dejó el
   percentil 90 en 1,4 ms. Resultado: 0,845 de F1 sintético y 1,5 ms de
   percentil 90 con la rejilla de P12-b.
5. **Guardas.** Nuevo nivel `alignment: beats`: beatmatch con pulso fiable en
   ambos cues y todo el solapamiento, velocidad ≤ 8 % y 5 ms de fase. `bars`
   solo si el 1 del modelo coincide con evidencia independiente (agrupación
   y fase de `metre` sobre la misma rejilla); si no, `beats`. Web
   (`metricCuePlacement`) y Android (`ProgramDjPlan`) hoy degradan todo lo que
   no sea `bars`: deben recolocar por pulsos enteros. Vectores comunes nuevos.
6. **Limpieza.** Retirar del pulso las hipótesis 3:2/4:3 de #394 y el código
   que deje de tener lectores.
7. **Evidencia.** Repetir la comparativa con el analizador integrado (debe
   igualar `beatthis-final0-dbn`), AAC → SQLite → HTTP frío/caliente, suites
   completas web/Android y comparación de la caché local v8/v9/v10.

El alcance y los criterios originales se conservan a continuación.

### Alcance

- Extender el modelo rítmico para expresar la unidad del pulso, su periodo,
  los pulsos por compás, la subdivisión, los inicios de compás y la cobertura
  temporal de cada estimación. Permitir ambigüedad, cambios por región y
  «desconocido»; no rellenarlos con un 4/4 que parezca medido.
- Separar confianza de pulso, de compás y de identificación del 1. Definir
  qué evidencia permite afirmar cada cosa. Una tonalidad clara o un pulso
  regular no deben elevar automáticamente la certeza del compás.
- Evaluar hipótesis de agrupación y subdivisión con señales conocidas,
  incluidos 3/4, 4/4 y 6/8. No limitarse a cambiar `range(4)` por otro número,
  ni tratar subdivisión ternaria como una relación de medio/doble tempo.
- Revisar conjuntamente selección de tempo, pulso/contratiempo y fase del
  compás. El detector actual favorece repeticiones binarias antes de estimar
  el 1; cambiar solo su última etapa deja ese sesgo intacto.
- Ajustar cues, duración del compás y solapamientos a las medidas locales.
  Medio/doble tempo debe conservar la interpretación del compás y la unidad
  declarada; no puede convertir por accidente dos compases en uno.
- Evaluar compatibilidad métrica por pareja y durante el tramo mezclado.
  Hacer coincidir los dos unos al inicio no asegura que sigan coincidiendo
  si los compases tienen distinta duración. Definir y verificar la alineación
  que realmente promete cada técnica, incluida una salida conservadora cuando
  no hay evidencia suficiente. No declarar incompatibles todos los compases
  distintos por defecto ni prometer alineación de compás basándose solo en BPM.
- Llevar la misma regla a ordenación, peticiones, reparación, refinado y
  puentes; la elección de una técnica y su admisión deben usar la misma
  validación métrica del par. Revisar el `score` y sus consumidores para que
  la calidad declarada no oculte que la alineación solicitada no es ejecutable.
- El servidor debe enviar la información necesaria para conservar el compás
  al recolocar cues. Retirar el `out_period * 4` implícito de web y Android y
  revisar `overlap_bars`, límites y tipos. Conservar compatibilidad explícita
  con planes antiguos o incompletos, sin presentar su 4/4 como una medida nueva.
- Mantener el eco ligado a un pulso saliente medido y a la velocidad real,
  con unidad inequívoca. Un cambio de compás no autoriza convertir el retardo
  en un compás ni deducirlo del tempo entrante.
- Invalidar las medidas antiguas con `ANALYSER_VERSION` y adaptar persistencia
  y resumen HTTP. Los clientes reciben el plan compacto, no las rejillas
  completas de todo el conjunto ni un detector musical propio.

### Criterios de cierre

- Fixtures reproducibles con pulsos, compases y subdivisiones conocidos:
  3/4, 4/4, 6/8, distintas posiciones iniciales, anacrusas, acentos débiles
  en el 1, síncopas, contratiempos y ambigüedad de medio/doble tempo. Incluir
  cambios de compás, deriva y material sin pulso o sin compás identificable.
- Medir por separado error de tempo, error temporal de pulso, acierto del
  compás/subdivisión, acierto del 1 y abstenciones. Fijar tolerancias con
  señales conocidas, sin notas humanas, puntuaciones de gusto ni calibración
  sobre canciones elegidas a posteriori.
- Reproducir el diagnóstico 3/4 → 4/4 anterior: no exigir una técnica concreta
  por su nombre; comprobar que el plan respeta la interpretación y garantías
  de alineación que declara. Cubrir también parejas compatibles y periodos
  locales distintos del BPM global.
- AAC → análisis → SQLite → HTTP, con sustitución de la caché anterior y
  casos fríos/calientes; vectores compartidos ejecutados por web y Android,
  incluyendo recolocación de cues sin volver a asumir cuatro pulsos.
- Evaluación separada con música real y referencia explícita, sin confundir
  acuerdo con otro detector con verdad musical absoluta. Informar cobertura,
  errores y límites por caso; la escucha física sigue siendo otra evidencia.
- Actualizar el funcionamiento vigente y los límites de P1/P8; P13 queda
  pendiente hasta comprobar frases y secciones sobre el nuevo modelo.

## P13. Frases y secciones sobre una base métrica explícita

**Estado: pendiente; siguiente trabajo tras P12-b.** La métrica es la de
P12-b: unos estimados por Beat This! y confirmados solo con evidencia
independiente. P12-b no cambió la agrupación de frases y secciones; ahora
cuenta ocho compases desde los unos del modelo. Las fixtures de estructura de
P12-a (`structure_4/8/16_bars`) están en el corpus fijado; All-In-One no
aportó una salida estructural útil sobre ellas (P12-a, RESULTS). P8 cerró el uso de las secciones al
planificar, no una detección general de forma musical. La agrupación actual
en ocho compases no demuestra dónde empieza una frase ni dónde cambia una
sección; ambas pueden parecer coherentes porque comparten la misma suposición.

### Alcance

- Distinguir la estimación del 1, el comienzo de frase y el límite de sección,
  con su evidencia y cobertura. Consumir el modelo rítmico de P12, sin otro
  detector de compás ni reconstrucción por módulos independientes.
- Revisar la agrupación fija de ocho compases y la fase inicial de esa
  agrupación. Contemplar frases de otras longitudes, anacrusas, extensiones
  y cambios de métrica; no basta con contar desde el primer 1 disponible.
- Estimar límites a partir de cambios medidos de estructura y contenido,
  contrastados con la métrica disponible. Cuando se use un supuesto de ocho
  compases como reserva, conservar su condición de supuesto y su incertidumbre.
- Separar detección del límite y etiqueta musical. Un salto de nivel por sí
  solo no prueba un drop; revisar intro, outro, build, breakdown y body con
  señales que distingan sus condiciones, sin notas de gusto ni nuevos pesos
  calibrados a oído. No forzar etiquetas cuando falta evidencia.
- Revalidar salida en outro/antes de breakdown, llegada al drop y mezcla larga
  de P7/P8: cues y solapamientos deben respetar la estructura medida y los
  límites reales de ejecución, sin usar frases y secciones correlacionadas
  como si fueran confirmaciones independientes.
- Mantener las regiones sin medir de archivos largos como desconocidas.
  No fabricar continuidad de frase, sección o compás a través del hueco.
- Mantener un único planificador para todos los endpoints y paridad de
  ejecución web/Android. Versionar la caché si cambian medidas o su significado.

### Criterios de cierre

- Señales conocidas con frases de cuatro, ocho y dieciséis compases, comienzos
  desplazados y extensiones; 3/4, 4/4 y 6/8; cambios de sección dentro y fuera
  del antiguo bloque fijo. Cubrir material ambiguo y ventanas discontinuas.
- Medir por separado error de límite, longitud/fase de frase, etiqueta de
  sección y abstenciones; distinguir el fallo heredado del pulso o compás del
  fallo propio de estructura. Las pruebas no deben fijar solo nombres de etiquetas.
- Probar que los límites y etiquetas cambian las decisiones correctas de
  salida, entrada y duración a través de AAC → SQLite → HTTP, y que el mismo
  plan llega ejecutable a web y Android sin ajustes que rompan la alineación.
- Conservar los límites físicos, la selección sin sesgo de caché y las demás
  decisiones vigentes. Registrar evaluación real y aceptación física por
  separado; actualizar tabla, funcionamiento y limitaciones al cerrar.
