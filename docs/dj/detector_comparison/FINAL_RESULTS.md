# P12: revalidación del analizador final

Medido el 2026-10-27, con el analizador 11 que llegó a la release.
**Las 62 entradas reproducen exactamente los BPM, las confianzas y las métricas
por caso del modelo y de la rejilla del informe integrado anterior.** No aparece
una regresión nueva en ese corpus ni se cambia producción. Se completa la
trazabilidad y se amplía la evidencia de parejas, AAC, SQLite, HTTP y ventanas largas.
P13 estaba pendiente en esta revalidación y se cerró después ([P13](../P13.md)); la decisión de Beat This! `final0` de #395 se conserva.

## Referencias y trazabilidad

- Corpus y particiones originales: 30 GTZAN (10 desarrollo, 20 test), 12 Ballroom
  vistos en entrenamiento y 20 señales conocidas. Audio y anotaciones verificados
  por SHA256 antes de inferir; tolerancias originales de 70/10 ms, sin cambios.
- [Analizador final, eventos y análisis completos](results/integrated-final.json.gz):
  revisión `2695bd9a`, versión del analizador, 42 hashes de
  fuentes, pesos, FFmpeg, Python, NumPy y ONNX Runtime. Cada fase identifica su
  propio evaluador; [procedencia de la release](results/final-provenance.json)
  comprueba que las fuentes del analizador coinciden con las publicadas.
- [Informe anterior](results/integrated-p12b.json): su hash queda en la comparación.
  No registró versión ni revisión: no se le asigna una retrospectivamente. Las
  igualdades anteriores son de las salidas medidas, no una conjetura de su código.
- [Comparación por caso](results/final-method-case.csv): baselines anteriores,
  `final0` DBN original, eventos del modelo y rejilla integrada final. Las
  [29 configuraciones originales](results/method-case.csv) se conservan; esta
  revalidación repite el método elegido, sin volver a inferir los descartados.
- Reproducción: comandos de [README](README.md#revalidación-del-analizador-final).
  Los `.json.gz` contienen JSON completo; no se redistribuye audio.

## Detección

F1 es de eventos, no porcentaje de canciones correctas. Se promedian los casos
con referencia; ausencia explícita de eventos y falta de anotación se conservan.
La agrupación y subdivisión por caso están en el CSV y los JSON, sin rellenar
la unidad notada de la música real ni plegar sus errores de tempo.

| Corpus / partición | Casos | F1 pulso, rejilla | F1 del 1, rejilla | Tempo correcto (<4 %) | Cobertura del 1 confirmado |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ballroom/seen_diagnostic | 12 | 0.9522 | 0.9733 | 12 | 0.0 % |
| GTZAN/development | 10 | 0.9151 | 0.8919 | 10 | 0.0 % |
| GTZAN/test | 20 | 0.8131 | 0.7695 | 14 | 0.0 % |
| synthetic/known_signal | 20 | 0.8449 | 0.7052 | 15 | 53.5 % |

Son 24/30 tempos correctos en GTZAN y F1 del 1 de 0,8103 al juntar desarrollo y
test; la separación fijada se mantiene en la tabla. Ballroom no acredita
independencia. Los 579 primeros tiempos confirmados de señales conocidas
coinciden con la referencia, sin falsas certezas; en música real no se confirma
ninguno. La confianza de pulso expresa estabilidad, no probabilidad de una
lectura musical correcta: once casos GTZAN test superan 0,6 y tres discrepan en
tempo de la referencia (`disco_00001`, `disco_00002`, `reggae_00002`).

Persisten errores de fase aunque el tempo sea correcto, como `gtzan_metal_00001`
y `synthetic_3_2_syncopated`, ambos con F1 del pulso 0 y confianza 1. Las señales
de dos pulsos ternarios conservan lecturas a otro nivel. Estos límites ya
estaban en el informe integrado; repetirlo no los convierte en detección resuelta.

## Continuidad sobre los eventos retenidos

[Continuidad del corpus](results/final-continuity.json) y
[de los AAC](results/final-continuity-aac.json), con `mir_eval` 0.8.2 en el
entorno experimental. No se repiten inferencias ni se añaden dependencias al
motor. El F1 recalculado coincide con el retenido para las dos salidas y todos
los casos; CMLc/CMLt/AMLc/AMLt completos quedan por caso en los JSON.

| Corpus / partición | Casos pulso/1 | CMLt pulso | CMLt del 1 | AMLt pulso | AMLt del 1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ballroom/seen_diagnostic | 12/12 | 0.9893 | 1.0000 | 0.9893 | 1.0000 |
| GTZAN/development | 10/10 | 0.9183 | 0.9671 | 0.9183 | 0.9671 |
| GTZAN/test | 20/20 | 0.6677 | 0.6928 | 0.9570 | 0.8898 |
| synthetic/known_signal | 18/17 | 0.7778 | 0.6367 | 0.8333 | 0.6956 |

CMLt y AMLt son métricas de continuidad distintas del F1 a 70/10 ms. No se
convierten en confianza del 1: el AAC real tiene F1 del 1 igual a 0, CMLt 0 y
AMLt 0,9375. Los casos sin eventos o sin referencia no se convierten en ceros;
la tabla muestra los denominadores efectivos. No se interpretan equivalencias
métricas como identificación correcta del primer tiempo anotado.

## AAC y ruta de producción

Los cinco AAC fijados antes de la comparativa son diagnósticos de códec, sin
ampliar el test independiente. [Resultados completos](results/integrated-final-aac.json.gz):

| Corpus / partición | Casos | F1 pulso, rejilla | F1 del 1, rejilla | Tempo correcto (<4 %) |
| --- | ---: | ---: | ---: | ---: |
| GTZAN/codec_diagnostic | 1 | 0.9920 | 0.0000 | 1 |
| synthetic/codec_diagnostic | 4 | 0.7267 | 0.7381 | 2 |

El AAC real conserva pulso (F1 0,992) pero su 1 tiene F1 0: no se oculta detrás
de la media sintética. Los sintéticos confirman 108 unos, ninguno falso.

[Producción → SQLite → HTTP](results/final-pipeline.json): ocho archivos, los
cinco AAC y tres WAV diagnósticos, analizados realmente con `analyse_audio`;
no se inyectan predicciones. Los ocho análisis coinciden íntegramente con las
salidas retenidas del probe. Las filas de la versión anterior no se admiten;
los ocho pares en frío usan reserva, con `measured: false` y `alignment: none`.

En caliente se comprueba el mismo plan en siete entradas: refinado, fuentes,
colocación, reparación, legacy y peticiones de pista/artista. Son 56 respuestas
con cero decodificaciones; la mayor ocupa 8645 bytes y el resumen no
incluye rejillas ni regiones completas. Cada archivo se decodifica una vez.
Las ocho mediciones frías suman 57.791 s de CPU y las ocho lecturas calientes
1.055 ms de CPU, una sola observación, sin intervalo de rendimiento.
El primer análisis frío incluye la carga del modelo.

La grabación larga de 600 s se genera repitiendo una señal fijada. Se decodifican
solo [0,90] y [480,600] s; las dos ventanas tienen regiones y rejilla, y el hueco
[90,480] no tiene ninguna. Pedir alineación en 300 s devuelve `none`.
Es una comprobación de cobertura, no otro corpus de precisión musical.

HTTP usa el cliente de pruebas y proveedores/adquisición sustituidos por
fixtures locales. No se abre la caché ni la biblioteca de la estación. Esto
valida producción desde archivos locales, no una descarga real del proveedor.

## Planificación de todas las parejas

[3782 parejas dirigidas, sin autorrepetición](results/final-pairs.json.gz),
con el plan completo retenido. Todas cumplen la coherencia entre técnica,
garantía y `beatmatch_fits`, el límite del 8 % y velocidad normal en reserva.
No se fuerza una técnica concreta ni se asignan pesos nuevos.

| Saliente / entrante | Parejas | `beats` | `bars` | `none` |
| --- | ---: | ---: | ---: | ---: |
| Ballroom/Ballroom | 132 | 38 | 0 | 94 |
| Ballroom/GTZAN | 360 | 66 | 0 | 294 |
| Ballroom/synthetic | 240 | 92 | 0 | 148 |
| GTZAN/Ballroom | 360 | 66 | 0 | 294 |
| GTZAN/GTZAN | 870 | 126 | 0 | 744 |
| GTZAN/synthetic | 600 | 146 | 0 | 454 |
| synthetic/Ballroom | 240 | 75 | 0 | 165 |
| synthetic/GTZAN | 600 | 116 | 0 | 484 |
| synthetic/synthetic | 380 | 170 | 40 | 170 |

En total: 895 `beats`, 40 `bars` y 2847 reservas. Los 40 `bars` son sintéticos;
sus 80 cues son contrastables y coinciden con unos anotados, sin falsos cues ni
abstenciones del evaluador. El pulso uniforme sin 1 identificable no obtiene
`bars`. En música real el máximo observado es `beats`; muchas parejas requieren
reserva por las guardas de ejecución. Admitir un plan no acredita calidad
perceptiva ni que el modelo haya elegido el 1 correcto cuando solo promete pulso.
Estas tasas pertenecen a los fragmentos fijados del corpus; no estiman la
admisión de beatmatch en canciones completas ni en la biblioteca del usuario.

## Coste y respuesta del servidor

CPU en segundos por minuto de audio, media de cocientes por caso, una pasada.
El modelo usa un hilo y una inferencia a la vez. Máquina Linux x86_64 compartida;
frecuencia y otras actividades no se controlan. Los fragmentos reales de 30,01 s
obligan a calcular dos bloques: no extrapolar su coste a canciones largas.

| Corpus / partición | Decodificación | Modelo + DBN | Medidas |
| --- | ---: | ---: | ---: |
| Ballroom/seen_diagnostic | 0.010 | 8.129 | 0.144 |
| GTZAN/development | 0.010 | 8.598 | 0.145 |
| GTZAN/test | 0.007 | 8.547 | 0.140 |
| synthetic/known_signal | 0.008 | 5.174 | 0.122 |

[Servidor gevent real, cliente en otro proceso](results/http-latency-final.json):
dos análisis completos simultáneos de WAV de 120 s, sin proveedores. Durante
la corrida final se responden 4684 peticiones: mediana
1.22 ms, p95 2.00 ms y máximo
25.18 ms. La referencia del mismo código publicado también se
repite en otro proceso; son observaciones de respuesta, no evidencia de una
optimización nueva. La memoria y el tamaño del modelo siguen documentados en
[RESULTS](RESULTS.md#ejecución-sin-pytorch); aquí no se vuelve a medir su pico.

## Validación y límites

La revalidación añade controles de integridad del corpus, cohortes y márgenes
de anotación. Validación local:

- Suite de comparación, modelo, rejilla, métrica y HTTP: 190 aprobados y una
  omisión por no encontrar pesos en `models/` dentro del worktree inicial.
- Seguimiento con los pesos verificados: 29 aprobados en comparación y
  checksum del modelo; incluye la comprobación omitida y los dos casos nuevos
  del margen de anotación. Los dos pases se solapan, no se suman como casos distintos.
- `ruff check docs/dj/detector_comparison tests/test_dj_detector_comparison.py`
  y `git diff --check` correctos; las siete corridas de medición/evaluación y la
  comparación de los ocho análisis con el camino de producción completadas.

Los checks de GitHub de la última cabecera se registran en la PR.
La implementación cambia únicamente el banco experimental y la documentación;
las fuentes de producción y la versión del analizador se conservan.

Esta corrida es Linux x86_64. No repite inferencia en Windows/ARM64, pruebas
físicas de reproductores web/Android ni escucha. Tampoco añade referencias de
la biblioteca personal, música no vista por todos los modelos o anotaciones
de frases/secciones. La continuidad se completa en la fase experimental indicada arriba; sus
ausencias explícitas no se convierten en ceros. Los límites originales de
generalización siguen vigentes y P13 conserva su aceptación independiente.
