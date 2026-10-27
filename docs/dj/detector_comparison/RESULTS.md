# P12-a: evidencia para elegir el detector

**Mediciones completas; el usuario eligió Beat This! `final0` (2026-10-26).**
La comparativa y la integración P12-b se fusionaron juntas en #395. Este
documento conserva la evaluación que precedió a la elección; la
[revalidación final](FINAL_RESULTS.md) contrasta el analizador que llegó a la release.
La tabla completa está en
`results/TABLES.md` y los registros por caso en `results/method-case.csv`.

## Recomendación

**Beat This! principal (`final0`) con su decodificador DBN de 3/4 pulsos,
ejecutado con ONNX Runtime y un frontend NumPy, sin PyTorch ni madmom en el
motor.** Es el método con mejor primer tiempo medido sobre música no vista,
con licencia MIT de código y pesos, y es el único candidato fuerte que puede
ejecutarse en todas las plataformas del motor (Docker `linux/amd64` y
`linux/arm64`, escritorio Windows x64 y arm64).

| Medida (música no vista por Beat This!) | `final0` DBN | `small0` DBN | Producción antes de #394 | #394 (en `main`) |
| --- | ---: | ---: | ---: | ---: |
| F1 del 1, test fijado (20 GTZAN) | 0,764 | 0,734 | 0,315 | 0,000 |
| F1 del 1, las 30 GTZAN (test + desarrollo) | 0,809 | 0,709 | 0,246 | 0,000 |
| F1 del pulso, test | 0,820 | 0,793 | 0,658 | 0,476 |
| Tempo a ±4 % de la referencia, 30 GTZAN | 24 | 19 | 21 | 10 |
| CPU s por minuto de audio, canción de 132 s, ONNX Runtime 1 hilo | 3,6 | 2,2 | 0,09 | 0,13 |
| Pico de memoria del proceso, ONNX Runtime, misma canción | 507 MiB | 383 MiB | — | — |
| Pesos ONNX | 84 MB | 11 MB | — | — |

Diferencias emparejadas del F1 del 1 (bootstrap 95 %). En el test fijado de
20 grabaciones, `final0` DBN frente a `small0` DBN: +0,031 [−0,064, +0,119],
sin diferencia demostrable. Con las 30 GTZAN: +0,100 [+0,004, +0,199]. Juntar
desarrollo y test es posterior al protocolo fijado; se admite como evidencia
adicional porque la partición de desarrollo no se usó para ajustar nada
(`calibration-results.json` es descriptivo, sin umbrales ajustados). Con las 30:
`final0` DBN supera también a su salida directa (+0,067 [+0,017, +0,122]),
a Beat Transformer (+0,105 [+0,021, +0,210]) y a madmom (+0,168 [+0,015,
+0,330]). Frente al detector previo a #394, también con las 30, `small0` DBN gana
+0,463 [+0,295, +0,620].

`small0` es la alternativa si se prioriza coste: un 40 % menos de CPU, 120 MiB
menos de memoria y pesos de 11 MB, a cambio de unos 0,10 de F1 del 1 y cinco
tempos correctos menos en 30 canciones.

### Por qué no los demás

| Método | Motivo para no integrarlo |
| --- | --- |
| Beat Transformer | 1 inferior a `final0` DBN: −0,045 [−0,138, +0,014] en el test fijado y −0,105 [−0,210, −0,021] en las 30 GTZAN. Exige Spleeter 2.3.2 en Python 3.8 + TensorFlow: un segundo runtime sin mantenimiento. |
| All-In-One | 1 inferior: −0,098 [−0,185, −0,024] en el test fijado (`fold0`). 15–124 s de CPU por minuto según la variante, más ~48 s/min de HTDemucs. En las señales de estructura etiqueta todo como `intro` y recupera el 25–37,5 % de los límites. |
| madmom (origen y fork) | 1 inferior: −0,106 [−0,282, +0,058] en el test fijado y −0,168 [−0,330, −0,015] en las 30 GTZAN. Pesos CC BY-NC-SA (uso no comercial). En PyPI solo existe el código fuente de 2018 (0.16.1, 19 MiB con modelos); el fork no está publicado. |
| BeatNet modelo 1 | 1 inferior: −0,237 [−0,413, −0,090] en el test fijado. Importa PyAudio también para archivos. |
| BeatNet modelo 2 | Entrenado con GTZAN: su 0,937 allí no es test independiente. En Ballroom, que no vio, su F1 del 1 es 0,637 (BeatNet 1 y Beat This!, que sí lo vieron: 0,974 y 0,988). No hay un corpus no visto por todos para compararlo. |
| BeatNet+ | Sin licencia de distribución en la revisión publicada. |
| Essentia, librosa | Solo pulso; no estiman primer tiempo. Essentia es AGPL. |
| Prototipos propios (`joint`, `joint-dbn`) | 1 con F1 0,000 y 0,273 en test. |
| Detector de #394 | Ver *Regresión medida en `main`*. |

## Ejecución sin PyTorch

[`onnx_probe.py`](onnx_probe.py) exporta cada checkpoint a ONNX (opset 17,
PyTorch 2.5.1) y reimplementa en NumPy el espectrograma log-mel de Beat This!,
el troceado en bloques de 1500 tramas y el posprocesado «minimal». La
ejecución usa un entorno Python 3.13 con solo NumPy y ONNX Runtime 1.31.
Compara contra las activaciones y eventos retenidos de la corrida principal,
sin volver a ejecutar PyTorch.

- Frontend NumPy frente a `LogMelSpect`: diferencia máxima 0,00018 (redondeo
  de float32). El detalle que importa es `normalized="frame_length"`: torchaudio
  divide por √n_fft, no por la norma de la ventana.
- Eventos idénticos en las 62 entradas, para `small0` y `final0`. Diferencia
  máxima de logits: 0,0002 y 0,0005.
- La exportación directa materializa todas las matrices de atención de
  1500 × 1500 a la vez: pico de ~1,1–1,6 GB. Exportar la misma operación por
  banda de frecuencia (atención en el tiempo del frontend) y por cabeza
  (transformer principal) baja el pico a 383 MiB (`small0`) y 507 MiB
  (`final0`), equivalente a PyTorch con el mismo archivo y método (440 y
  501 MiB). La exportación partida también da eventos idénticos en las 62
  entradas. Desactivar el arena de ONNX Runtime sube el pico (541 y 734 MiB).
- CPU en la canción de 132 s: 2,2 s/min (`small0`) y 3,6 s/min (`final0`);
  PyTorch, 2,1 y 3,7 s/min. Cifras en `results/onnx-memory.jsonl`, un
  proceso nuevo por configuración. Los fragmentos GTZAN de 30,01 s ocupan 1501 tramas
  y obligan a calcular dos bloques completos: por eso las tablas de la corrida
  principal muestran casi el doble por minuto.
- Ruedas en PyPI consultadas el 2026-10-26: ONNX Runtime 1.31.0 publica para
  Python 3.11–3.14 en Linux x86_64/aarch64, macOS arm64 y Windows x64/arm64
  (14–23 MB). PyTorch 2.14.1 no publica Windows arm64 y su rueda Linux x86_64
  pesa 529 MB.

No se ha ejecutado todavía en Windows ni en ARM64: la disponibilidad de ruedas
no sustituye esa prueba, que corresponde a P12-b.

Coste estimado en una biblioteca: una canción de 4 minutos son ~14 s de CPU
con `final0` (~9 s con `small0`), frente a 0,4 s del análisis actual. Mil
canciones son ~4 h de CPU de un hilo en un Ryzen 7 5800X (~2,5 h con
`small0`), repartidas entre los dos hilos de análisis en segundo plano. En
ARM64 de gama baja será varias veces más lento; no está medido.

## Integración en el motor (P12-b)

Medido después de la decisión con el analizador de producción completo
(`integrated_probe.py`, `results/integrated-p12b.json`): FFmpeg a 22050 Hz
desde los archivos, Beat This! en ONNX Runtime, DBN en NumPy y rejilla de P1.

- El DBN NumPy del motor reproduce los eventos de madmom en las 62 entradas,
  con ambos checkpoints (`results/dbn-port.json`), a 0,24 s de CPU por minuto
  de audio.
- Eventos del modelo en GTZAN test: F1 del pulso 0,820 y del 1 0,768, como
  `beatthis-final0-dbn` en la comparativa (0,820 y 0,764), con otra
  decodificación y el tiempo leído entre tramas.
- Rejilla final: F1 del pulso 0,813 (test) y 0,915 (desarrollo); del 1, 0,770 y
  0,892. Tempo a ±4 % en 24 de las 30 GTZAN. Una primera versión alineaba a
  ataques en ±35 ms, como P1, y en `gtzan_rock_00001` saltaba a un ataque 32 ms
  antes del pulso (F1 de 1,0 a 0,78). Se limita a una trama del modelo, 20 ms.
  En señales sintéticas el percentil 90 del error de pulso es 1,5 ms.
- Servidor durante el análisis (`scripts/benchmark_dj_analysis.py --http`,
  `results/http-latency-p12b.json`): con dos análisis completos de 120 s a la
  vez, 3129 peticiones respondidas con mediana de 0,39 ms, p95 de 0,99 ms y
  máximo de 10,6 ms. La inferencia corre fuera del bucle de gevent.
- Confirmación independiente del 1: 0 % de cobertura en GTZAN y Ballroom, y
  54 % en señales sintéticas con precisión 1,0 (579 unos confirmados, ninguno
  falso). En los beatmatches de música real la garantía máxima es `beats`;
  los pares que no se admiten usan `none`. `bars` exige que la armonía y los
  acentos repitan de forma medible el compás del modelo.

## Lo que esta comparación no resuelve

- **Confianza del 1.** La activación de la red no distingue aciertos de
  errores: con `final0` DBN el 93 % de los unos emitidos en test tiene
  activación > 0,8 y su precisión es 0,82. Los errores son compases enteros
  desplazados con la misma activación alta. P12-b exige la confirmación
  independiente descrita arriba para certificar `alignment: bars`; una
  sigmoide no se interpreta como probabilidad.
- **Controles sin primer tiempo.** Todos los modelos neuronales inventan unos
  en el pulso uniforme (`final0` DBN: 47 sin referencia). La guarda no puede
  certificar solo con la salida del modelo.
- **DBN.** Es código de madmom. Integrarlo como dependencia no es viable (ver
  tabla); P12-b lo porta a NumPy con igualdad comprobada (arriba).
- **Nivel de lectura.** El DBN de Beat This! agrupa en 3 o 4 pulsos y elige
  un nivel de pulso; un 6/8 o un 12/8 queda leído a un nivel u otro. La
  variante 2/3/4/6 (`-common`) no mejora la música real: 0,040 por debajo del
  DBN 3/4 en las 30 GTZAN (IC [−0,097, +0,010]). Por decisión del usuario, la
  mezcla no depende de la lectura: P12-b alinea el ciclo común de ambos pulsos
  (relaciones 2ᵃ·3ᵇ). Beat This! no estima subdivisión: esos campos del
  contrato los mide el analizador por su cuenta o quedan desconocidos.
- **Muestra.** 30 grabaciones GTZAN de 30 s, casi todas en 4; una sola
  ternaria. Ballroom está en el entrenamiento de Beat This!. Los resultados
  no acreditan detección general de cualquier compás.
- **P13.** Ningún candidato aporta estructura útil (All-In-One, arriba).
  Frases y secciones se construirán sobre la métrica elegida.

## Regresión histórica de #394 (sustituida por #395)

#394 se fusionó como `3f98b485` con el detector medido aquí como `soundsible-p12`:
`shared/` no cambia entre `2ca8ccf2` y `3f98b485`. Se midió antes de publicar
la siguiente release; #395 sustituyó ese detector antes de su publicación.

- En las 30 GTZAN, el tempo correcto baja de 21 a 10 canciones. Los errores
  nuevos son relaciones 3:2 y 4:3 en pop, hip-hop, metal, rock, disco y reggae
  en 4/4 que el detector anterior acertaba (por ejemplo +49,5 %, −24,8 %,
  +27,2 %). Son las relaciones ternarias que P12 añadió a la selección del pulso.
- El 1 no se identifica en ninguna grabación real (F1 0,000; cobertura de
  agrupación correcta 1,5 %). Las técnicas de beatmatch exigen `alignment:
  bars`, así que con música real casi todas las transiciones son de reserva.
- Caché local del usuario el 2026-10-26: de 278 canciones analizadas por las
  dos versiones (v8 y v9), 162 cambian de BPM (66 ×1,5, 54 ×2, 14 ×4/3, 27
  otras) y 116 lo conservan. En las 272 canciones v9, el 1 identificado cubre
  de media el 2,2 % de la duración analizada; ninguna llega al 50 %.

Su detección de compás en señales sintéticas es la mejor de la comparativa
(F1 del 1: 0,990), pero no se traslada a la música real.

## Qué responde esta comparación

Se contrasta la detección del pulso y del primer tiempo, la agrupación observada,
la subdivisión cuando existe, la precisión temporal y el coste de ejecución.
F1 combina precisión y recobrado de eventos: no es un porcentaje de canciones
ni de compases interpretados correctamente. La agrupación, su cobertura y la
subdivisión se puntúan por separado. Un campo ausente conserva esa condición.

Las dos referencias propias son el motor anterior a #394 (`8f520a79`,
`soundsible-main`) y #394 (`2ca8ccf2`, `soundsible-p12`). #394 se fusionó
después en `main` como `3f98b485`, sin cambios en `shared/` respecto a la
revisión medida. La elección del usuario precedió a P12-b; ambos trabajos
se entregaron en #395. Las salidas originales se conservan como referencia.

## Protocolo y alcance

Se fijaron las mismas 62 entradas antes de inferir: 30 GTZAN, doce Ballroom
ya diagnosticados, 17 señales rítmicas y tres de estructura. GTZAN reserva
el índice cero de cada género para desarrollo y los índices uno y dos para
test: diez y veinte grabaciones, respectivamente. No se entrenaron modelos,
no se ajustaron umbrales y no se eligieron canciones después de ver resultados.
Las tolerancias son 70 ms en música y 10 ms en señales conocidas. Los SHA256
del audio y de las referencias quedan en los manifiestos.

Las señales cubren agrupaciones de tres y cuatro pulsos, dos pulsos con
subdivisión ternaria, anacrusas, unos débiles, síncopas, deriva, cambios,
silencio, tono y pulso uniforme sin primer tiempo identificable. La unidad
notada y la subdivisión de la música real no están anotadas: no se inventa
una verdad de 6/8 a partir de dos pulsos detectados. El test real contiene
mayoritariamente agrupaciones de cuatro y solo una grabación ternaria.
Por tanto, su media no acredita una detección general de cualquier compás.

Ballroom permanece como diagnóstico visto. Las exclusiones de entrenamiento
son declaraciones de los autores por corpus, con excepciones por checkpoint;
no se dispone del audio de entrenamiento para descartar duplicados de una
misma grabación entre corpus. BeatNet modelo 2 incluye GTZAN en entrenamiento:
su resultado allí debe verse como diagnóstico y no competir como test
independiente. El detalle por familia está en `results/training-overlap.json`.

Cada backend se ejecuta por separado, con un hilo y dos pasadas por entrada.
La máquina es un Ryzen 7 5800X con 32 GB, Linux x86_64, compartida con otras
actividades del usuario. Se registra tiempo de CPU y de pared; no se controla
la frecuencia del procesador ni se presenta la pared como un microbenchmark
estable. El muestreo de memoria usa otro proceso sin el evaluador, el mismo
fragmento real de 30 segundos y dos pasadas; ese pico no garantiza el máximo
de cualquier canción larga.

## Costes que no deben confundirse

Los derivados de audio se comparten y se cachean por bytes y transformación.
`frontend-costs.json` mide por separado la decodificación y el remuestreo con
cachés nuevas. La tabla de backends usa esos derivados ya preparados. Su suma
con el frontend es una estimación por componentes, no un pipeline completo
nuevo cronometrado.

All-In-One y Beat Transformer necesitan separación. Se conserva el coste de
preparación aunque otra pasada o variante reutilice el espectrograma. Se
informa además de la inferencia con el frontend cacheado. Las variantes
que reutilizan separación, como el ensemble, suman el coste de preparación
medido previamente y el de su inferencia; no se ha cronometrado otro pase
completo con separación fría para cada variante. Las variantes
`-common` reutilizan activaciones: su cronómetro mide el decoder; se conserva
el coste de la fuente y se presenta su suma, sin atribuir al método completo
la pequeña latencia del posprocesado.

La carga del modelo está en los metadatos; las descargas quedaron fuera del
cronómetro. Los locks registran los entornos ejecutados. El tamaño instalado
usa los archivos declarados por las dependencias, sin intérprete ni cachés:
no es una medición de un instalador mínimo. Algunos paquetes incluyen pesos,
también modelos no usados; esas columnas no deben sumarse como si fueran
archivos disjuntos. No se midió de forma controlada
el tiempo de instalación, que incluyó descargas y compilación exploratoria.

Durante la corrida se movieron entornos y datos a `/mnt/storage` para evitar
llenar la raíz. La pausa duró 4,116 s; el tiempo de pared de la entrada afectada
se excluye, conservando su CPU. La ubicación de E/S cambió y se declara como
otra limitación de la pared. Los temporales posteriores también van a ese disco.

## Software, pesos y mantenimiento

| Familia | Evidencia y trabajo necesario para integrar |
| --- | --- |
| Beat This! | [Código y pesos MIT](https://github.com/CPJKU/beat_this/tree/b95c8ab0c58c2d9fcfd40508ae8dffbc05ac4f5c). Se comparan pequeño/principal y salida directa/DBN. PyTorch y torchaudio son una parte importante del runtime. |
| BeatNet | [Repositorio CC BY 4.0](https://github.com/mjhydri/BeatNet/tree/81cedd4beeb7235262db80969a0c9ce9a48a0ed4), checkpoints y modos DBN/PF explícitos. El paquete importa PyAudio incluso para archivos offline. No confundir los modelos que excluyen GTZAN y Ballroom. |
| BeatNet+ | [Fuentes y pesos publicados](https://github.com/mjhydri/BeatNet-Plus/tree/bb90eb0a9065b101a4b4c4cb2b2061950266cb4b); no se ha localizado una licencia de distribución en esa revisión. Se mide y se declara esta limitación. |
| madmom/origen y fork moderno | Código BSD; [pesos CC BY-NC-SA](https://github.com/CPJKU/madmom_models/blob/7e3dc1b0cad499792767074d03c38b194b9b0a79/LICENSE). Las matrices de los veinte archivos comparados son idénticas; el fork es una variante de mantenimiento, no otra familia entrenada. Usar solo el DBN no requiere las redes; una integración deberá revisar qué archivos distribuye. |
| All-In-One | [Código MIT](https://github.com/mir-aidj/all-in-one/tree/18e78903c0365147a2c5d4e5e57ebf88cb7d800e) y [tarjeta MIT de pesos](https://huggingface.co/taejunkim/allinone/tree/379e5fd010b3fdd0ee8381ff8cbcfa51d70b5c19). Necesita NATTEN, madmom y HTDemucs. La antigüedad del código y el coste de sus ocho redes importan para mantenerlo. |
| Beat Transformer | [Código y checkpoints](https://github.com/zhaojw1998/Beat-Transformer/tree/063667fc9e4e11507f9d76dc1154d9db953a85eb), licencia MIT del proyecto. Se usa el frontend de su Colab con Spleeter 2.3.2; exige un entorno Python 3.8/TensorFlow separado en este experimento. |
| Essentia y librosa | Controles de pulso: [Essentia AGPL](https://github.com/MTG/essentia) y [librosa ISC](https://github.com/librosa/librosa). Sus algoritmos probados no proporcionan primer tiempo ni subdivisión; no se les atribuye esa capacidad. |
| Prototipos propios | Comparación BIC de hipótesis y DBN conjunto con observaciones de ataque/cambio armónico. Son experimentos acotados, con sus errores visibles; no se presentan como detectores musicales ya resueltos. |

La instalación y la inferencia local en Linux no acreditan distribución en
ARM64, Windows o macOS. Las comprobaciones Python 3.14 se distinguen del
entorno Python 3.11 de rendimiento y del worker Python 3.8. La compatibilidad
con las plataformas de entrega del producto sigue siendo trabajo de P12-b.

Se inspeccionó además [md_beat_this](https://github.com/fosfrancesco/md_beat_this/tree/aca41a23a26881ba3d1e5b5e4bc3f4869d6a3ed7):
la revisión contiene evaluación y predicciones, pero no inferencia y pesos
ejecutables sobre nuestras entradas congeladas. Se excluye por esa falta de
reproducción, conservando el motivo en el inventario.

## Contrato de mezcla y límites de P13

Los backends se ejecutan sobre WAV y AAC. Un único adaptador lleva sus
observaciones a SQLite aislada y al planificador HTTP de la referencia #394.
Las confianzas que no proporciona el backend siguen ausentes en bruto y pasan
como evidencia cero a sus guardas. Una sigmoide alta no certifica por sí sola
el compás ni el 1. Por ello, un plan conservador no demuestra que el modelo
no pueda llegar a ser útil; tampoco acredita detección por abstenerse siempre.

El pulso uniforme del corpus no tiene primer tiempo identificable. Los
detectores que lo inventan quedan penalizados aunque acierten su tempo.
La referencia P12 produce sesenta unos y confianza local de agrupación/1
igual a uno al recibir la versión remuestreada desde 44100 Hz; su test original
sintetiza directamente a 11025 Hz. Esa diferencia se diagnostica aparte,
sin modificar el corpus ni reajustar el detector. La cobertura y las guardas
de unidad siguen siendo necesarias; la confianza local tampoco es verdad
musical calibrada.

Se prueban fuentes, peticiones de pista/artista, colocación, reparación,
legacy y refinado; estado frío/caliente, ausencia de decodificación en caliente
y respuestas compactas. La inyección en SQLite valida esa frontera y sus
consumidores; no sustituye la adquisición de producción ni demuestra todavía
cuántas mezclas musicales puede habilitar de forma segura el elegido.

Las tres señales de estructura tienen cambios de contenido conocidos cada
cuatro, ocho y dieciséis compases. Se contrastan los límites de All-In-One,
sin usar sus etiquetas como verdad musical. No hay una evaluación anotada de
frases reales, drops ni secciones: P13 sigue pendiente, con fixtures preparadas.
La ejecución de contratos web/Android y la escucha física son evidencias
separadas de las métricas del detector.
