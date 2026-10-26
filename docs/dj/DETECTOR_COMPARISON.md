# P12-a: comparar detección conjunta y alternativas abiertas

**Encargo del usuario, 2026-10-25: autorizado y siguiente trabajo.** Probar la
estimación conjunta de pulso, compás y primer tiempo y varias soluciones de
código abierto mantenibles; comparar todos los métodos admitidos con las
mismas entradas. Con los resultados sobre la mesa, **el usuario decidirá** qué
integrar. Beat This! es un candidato, sin preferencia acordada. Este documento
registra el trabajo pendiente; no contiene resultados nuevos de detectores.

P12 queda **parcial**: la PR #394 implementa contratos y guardas, pero los doce
fragmentos reales de [P12](P12.md) no acreditan compás y 1 correctos. La
abstención protege la mezcla; por sí sola no resuelve la detección. P13 depende
de esta decisión. No se reabre P2 ni se cambia el reloj de reproducción.

## Orden para desarrollar rápido sin rehacer código

| Bloque | Entrega concreta | Dependencia / límite |
| --- | --- | --- |
| P12-a, banco común y comparativa | Un runner, adaptadores aislados, corpus fijado, resultados por método/caso y prueba de su salida a través del planificador y de las fronteras existentes | Autorizado ahora; llegar casi de extremo a extremo sin seleccionar ni sustituir el detector de producción |
| Decisión del usuario | Tabla de precisión/cobertura, errores, costes y mantenibilidad; opciones y compromisos sin ganador por pesos de gusto | Parada explícita antes de elegir e integrar; tener resultados, no solo planes o cifras de los artículos |
| P12-b, integración del elegido | Una implementación musical, persistencia, HTTP, rutas y ejecución web/Android; cierre de P12 con evidencia real | Después de la decisión; aprovechar el contrato de #394 y retirar prototipos de producción que no se utilicen |
| P13, frases y secciones | Consumir la métrica elegida y validar forma musical | Diseñar fixtures y registrar límites durante P12-a; implementar después de estabilizar esa métrica. Se puede entregar junto a P12-b si reduce cambios repetidos y ambas aceptaciones se verifican por separado |

La regla de un punto por sesión no obliga a microentregas en este encargo:
el usuario autoriza avanzar por bloques amplios y casi de extremo a extremo.
No hacer una PR de producción por cada detector. Construir juntos el banco y
los adaptadores, ejecutar la comparativa completa y presentar resultados.
Después, integrar la opción elegida en un bloque amplio; evitar reescribir
`rhythm`, `structure` y los consumidores una vez por candidato.

## Candidatos y controles iniciales

Inventario consultado el 2026-10-25 en repositorios y documentación de sus
autores. Las fechas y licencias publicadas son evidencia de inventario, no una
certificación de mantenibilidad ni una medición de Soundsible. Fijar la revisión
real y el hash de **cada checkpoint** al ejecutar. No confundir variantes,
postprocesadores y forks con familias de modelos independientes.

| Método / familia | Qué contrastar | Admisión y límites conocidos |
| --- | --- | --- |
| Soundsible previo a #394 (`8f520a79`) y detector de #394 (`2ca8ccf2`) | Dos baselines: supuesto de cuatro pulsos frente a agrupación/abstención local | Congelar las revisiones; conservar resultados originales sin recalibrarlas sobre el test |
| Prototipo conjunto propio | Varias hipótesis de pulso, subdivisión, compás y fase durante varios compases; decodificación temporal conjunta con observaciones rítmicas y armónicas | Desarrollar como adaptador experimental; no fijar primero un BPM único ni exigir que el 1 sea el golpe más fuerte. Sin nuevos pesos de gusto |
| [Beat This!](https://github.com/CPJKU/beat_this) | Modelo principal y pequeño; salida directa y, como variante separada, decodificación temporal común sobre activaciones | Pulsos y unos; CPU y checkpoints disponibles. Código y pesos publicados MIT. El upstream advierte del solapamiento de entrenamiento: sus modelos principales/pequeños excluyen GTZAN, no por ello cualquier otro corpus |
| [BeatNet](https://github.com/mjhydri/BeatNet) | CRNN con inferencia offline DBN y variante PF procesando el archivo sin esperar al tiempo real | Pulsos/unos y seguimiento métrico; CPU y pesos publicados. Revisar las dependencias de madmom y PyAudio incluso en modo offline. El repositorio declara CC BY; verificar términos del checkpoint concreto |
| [madmom](https://github.com/CPJKU/madmom) y [madmom-modern](https://github.com/imcmurray/madmom-modern) | RNN de pulsos/unos y DBN; origen como referencia y fork compatible como variante de mantenimiento | El fork declara compatibilidad con Python/NumPy actuales. Código BSD y modelos publicados CC BY-NC-SA: registrar por separado; no asumir que pueden distribuirse como pesos sin restricciones. Verificar instalación, tests y divergencias del fork |
| [Beat Transformer](https://github.com/zhaojw1998/Beat-Transformer) | Transformer de pulsos/unos con entrada separada en fuentes y su postprocesado | Código MIT y checkpoints en el proyecto. Medir también preparación/separación y dependencias; valorar mantenimiento del código de investigación y términos de pesos, sin convertir una adaptación extensa en requisito de la comparativa |
| [All-In-One](https://github.com/mir-aidj/all-in-one) | Pulsos/unos y segmentación en una misma familia; variante sin hacer trabajo de estructura que no necesitemos, si el upstream la admite | Interesa también para evitar duplicar P13. Documenta PyTorch, NATTEN, madmom y separación de fuentes; instalación nativa en Windows y coste completo por comprobar. Código MIT; verificar pesos y dependencias separadamente |
| [Essentia RhythmExtractor2013](https://essentia.upf.edu/reference/std_RhythmExtractor2013.html) | `multifeature` y `degara` como dos baselines de pulso/coste | El algoritmo devuelve tempo y pulsos, no unos; sin puntuación de primer tiempo intrínseca. Entrada a la frecuencia exigida por su API; `degara` no estima confianza. [Repositorio AGPL](https://github.com/MTG/essentia) |
| [librosa](https://github.com/librosa/librosa) | `beat_track` y pulso local como controles de seguimiento/deriva | Baseline de pulso, no detector completo de compás/1. Código ISC; usar [API oficial](https://github.com/librosa/librosa/blob/main/librosa/beat.py). Un híbrido con nuestro decodificador será otro método explícito, nunca capacidad atribuida a librosa |

El modelo conjunto con una red y decodificación temporal tiene antecedentes
reproducibles en [Böck, Krebs y Widmer, ISMIR 2016](https://archives.ismir.net/ismir2016/paper/000186.pdf).
No se exige implementar de nuevo todas esas redes: comparar primero los
paquetes/pesos públicos y el prototipo conjunto acotado. Si aparece otro
candidato mantenible con código, pesos y ejecución reproducibles, añadirlo al
inventario antes de congelar la corrida. La lista no pretende enumerar todos
los artículos existentes.

### Revisiones consultadas

| Repositorio | Revisión consultada | Fecha del commit consultado |
| --- | --- | --- |
| CPJKU/beat_this | [`b95c8ab0c58c`](https://github.com/CPJKU/beat_this/commit/b95c8ab0c58c2d9fcfd40508ae8dffbc05ac4f5c) | 2026-05-28 |
| mjhydri/BeatNet | [`81cedd4beeb7`](https://github.com/mjhydri/BeatNet/commit/81cedd4beeb7235262db80969a0c9ce9a48a0ed4) | 2026-04-13 |
| zhaojw1998/Beat-Transformer | [`063667fc9e4e`](https://github.com/zhaojw1998/Beat-Transformer/commit/063667fc9e4e11507f9d76dc1154d9db953a85eb) | 2024-04-07 |
| mir-aidj/all-in-one | [`18e78903c036`](https://github.com/mir-aidj/all-in-one/commit/18e78903c0365147a2c5d4e5e57ebf88cb7d800e) | 2023-10-10 |
| CPJKU/madmom | [`27f032e89472`](https://github.com/CPJKU/madmom/commit/27f032e8947204902c675e5e341a3faf5dc86dae) | 2024-08-25 |
| imcmurray/madmom-modern | [`df718c704a3b`](https://github.com/imcmurray/madmom-modern/commit/df718c704a3b460ac6c61b7e61663a0436b91bda) | 2026-02-16 |
| MTG/essentia | [`33108c709296`](https://github.com/MTG/essentia/commit/33108c70929684ed14091dfb671a30264cf8bb84) | 2026-10-22 |
| librosa/librosa | [`4ffed287f904`](https://github.com/librosa/librosa/commit/4ffed287f9044654cc4a1a7393f895cd716a0a5d) | 2026-10-22 |

La antigüedad de un commit no decide por sí sola la admisión. Comprobar
actividad útil, CI/tests, instalación reproducible, plataformas y dependencia
de parches propios. Ningún candidato de esta tabla se ha instalado o medido
para la nueva comparativa todavía.

## Un solo banco y una sola frontera

- Un responsable del runner, manifiesto, unidades y adaptador hacia el contrato
  P12. Cada familia vive en su propio módulo de adaptador. Si se reparte el
  trabajo, asignar archivos distintos; los adaptadores no editan el planificador,
  `rhythm`, `structure`, las stores o el mezclador nativo.
- Separar ejecución del backend, normalización y métricas. Un resultado incluye
  método/revisión/checkpoint/configuración, tiempos de pulso/1 en segundos,
  agrupación/subdivisión/unidad si existen, cobertura, activaciones o confianza
  originales disponibles y ausencias explícitas. Conservar salida bruta para
  recalcular métricas sin repetir inferencias.
- Un único decodificador de entrada y derivados cacheados por bytes,
  transformación, frecuencia y configuración. Cada método recibe el formato
  que necesita; no alimentar a todos con la reducción de frecuencia de P1.
  Contar el coste de remuestreo/espectrogramas/separación aunque se cacheen.
- Modelos y dependencias experimentales en entornos aislados o contenedores,
  fuera de `requirements.txt` y de los paquetes de distribución del motor.
  Dependencias y pesos fijados; descargas preparadas antes de medir. Un fallo
  de instalación, falta de pesos o restricción de licencia se registra como
  resultado de admisión, no se oculta ni obliga a mantener un fork grande.
- Congelar primero el contrato mínimo del experimento; ampliar solo si falta
  una medida necesaria. Aprovechar `metric_regions` y el plan compacto de
  #394. No invalidar la caché de producción para ejecutar el banco aislado.
- En la comparativa, no entrenar desde cero ni separar fuentes para todos por
  defecto. Ejecutar el pipeline documentado cuando un candidato lo necesite,
  identificándolo y contabilizando su coste. Una variante optimizada será una
  fila aparte, con igualdad de resultados comprobada.

## Corpus, comparación justa y métricas

Fijar manifiesto, referencias, particiones, tolerancias y configuración antes
de ejecutar. Las doce pistas Ballroom de P12 son **diagnóstico ya visto**,
no test ciego. Para cada checkpoint declarar si cada grabación fue vista en
entrenamiento, excluida o de procedencia desconocida. No presentar como
validación independiente un resultado con solapamiento conocido o no aclarado.
GTZAN puede servir de test para los checkpoints de Beat This! que lo excluyen;
comprobarlo para cada otro candidato, sin extrapolar esa exclusión a todos.

Usar las mismas grabaciones sintéticas y reales para todos los métodos, con
las ventanas y offsets registrados. Añadir a los casos existentes 3/4, 4/4,
6/8, subdivisiones coexistentes, cambios de métrica/tempo, anacrusas, 1 débil,
síncopas, contratiempos, silencio y pulsos sin compás identificable. Para la
música real, cubrir estilos y condiciones variados con referencias temporales
auditables. Las referencias son anotaciones musicales, no notas de gusto.
Conservar regiones ambiguas como tales y no escoger canciones después de ver
qué método gana.

Medir por separado, con resultados por caso, estilo, unidad y cobertura:

- Error de tempo sin ocultar octavas o relaciones 3:2; documentar además las
  equivalencias de unidad que preservan realmente la duración del compás.
- Precisión/recobrado/F1 y continuidad de pulso y de primer tiempo, error
  temporal mediano/percentiles y desplazamiento de fase del compás.
- Acierto de agrupación, subdivisión, duración física del compás y cambios;
  los campos no proporcionados son «no disponible», nunca un 4/4 inferido a
  escondidas. Un híbrido se evalúa con su nombre y componentes completos.
- Cobertura, abstenciones y **falsas certezas**: error cuando el método afirma
  conocer el 1. Abstenerse en todas las canciones no cuenta como solución.
  Las activaciones de una red tampoco son una confianza musical calibrada
  por el mero hecho de pasar por una sigmoide; comprobar su relación con el
  error en la partición de desarrollo y evaluar el resultado en la de test.
- Salida cruda y salida con el mismo refinamiento temporal de ataques de P1,
  por separado. Distinguir equivocarse de pulso/compás de colocar tarde un
  ataque correcto. No dar a cada backend un arreglo distinto ajustado al test.
- Tiempo de instalación y carga, latencia fría/caliente, segundos de CPU y de
  pared por minuto de audio, pico de RAM, disco/pesos y tamaño del runtime.
  CPU es la referencia obligatoria; GPU opcional como otra configuración.
  Medir un método cada vez, mismo hardware e hilos, con repeticiones y
  variabilidad. Separar coste del backend y coste total del pipeline.
- Mantenibilidad: código y pesos con términos identificados, disponibilidad
  reproducible, tests, compatibilidad con Python/NumPy del proyecto y
  distribución Linux/ARM64/Windows/macOS; necesidad y tamaño de parches.

Publicar una matriz **método × caso**, resúmenes con incertidumbre y una tabla
comparativa completa. Incluir todos los métodos admitidos, sus variantes,
fallos, ausencias y motivos de exclusión. No elegir ganador con una suma de
pesos escritos a gusto; presentar los compromisos de precisión, cobertura,
coste y mantenimiento para la decisión del usuario.

## Llegar casi de extremo a extremo antes de decidir

El banco no termina en un listado de BPM. Convertir cada salida que disponga
de evidencia suficiente al contrato P12 mediante **un mismo adaptador**, sin
inventar campos. Reutilizar el planificador para comprobar pares compatibles,
3/4 → 4/4, unidades diferentes que conservan compás, cambios dentro del tramo,
deriva y desconocidos. Medir cuántas mezclas válidas habilita y cuántas falsas
alineaciones promete cada método. Conservar las guardas de velocidad, fase,
cobertura y eco de P12.

Ejecutar también la ruta AAC/WAV → decodificación → backend → normalización →
SQLite experimental → planificación/rutas → HTTP de fuentes, peticiones,
colocación, reparación y refinado. Cubrir frío/caliente, fallo/timeout,
identidad/configuración de caché y huecos de grabaciones largas. Las salidas
compactas y los vectores de ejecución existentes permiten contrastar web y
Android sin crear una interfaz nueva por candidato ni mover lógica musical
al cliente. Marcar claramente qué parte se ha ejecutado y qué parte solo se
ha validado como contrato; la escucha física sigue siendo evidencia aparte.

P13 se prepara aprovechando ese trabajo: fixtures de frases/secciones y
registro de la salida estructural de All-In-One si se evalúa. Esa salida se
puntúa con referencias propias de estructura; compartir modelo con el pulso
no prueba por sí solo una frase ni un drop. No reescribir ahora el detector de
secciones sobre una métrica que podría sustituirse tras la comparativa.

## Cierre de P12-a y entrega para decidir

- Runner reproducible, manifiestos y revisiones/checkpoints fijados; informe
  por caso y tabla de todos los métodos admitidos y excluidos con su motivo.
- Separación entre diagnóstico, desarrollo y test independiente; solapamientos
  de entrenamiento y ausencia de referencias documentados.
- Resultados musicales y de ejecución casi de extremo a extremo, junto con
  coste y mantenimiento. Criterios/tolerancias fijados antes del test; los
  tests verdes de software no sustituyen la evidencia de detección.
- Presentar al usuario opciones sustentadas por esos resultados y **esperar
  su decisión**. No cambiar automáticamente el detector de producción, su
  caché, las políticas musicales ni empezar la reescritura de P13.

Tras la elección, P12-b integra una sola vía musical y comparte su evidencia
con P13. Agrupar persistencia, endpoints y ejecutores en una entrega coherente,
con invalidación de análisis si cambia su significado y las regresiones que
correspondan. P12 solo se cierra cuando hay evidencia real de utilidad de la
detección y garantías de ejecución; P13 conserva su propia aceptación de
frases/secciones aunque ambos se entreguen juntos.
