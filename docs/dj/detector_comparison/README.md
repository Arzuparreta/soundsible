# Banco experimental de compás y primer tiempo

Comparación P12-a, fuera de las dependencias y de la caché de producción.
No importa este paquete el motor ni se elige automáticamente un método.
La implementación y su PR quedan después de la valoración del usuario.

El informe interpretativo está en [RESULTS](RESULTS.md); las tablas y los
registros compactos se generan con `export` una vez completada la corrida.

El banco separa cuatro cosas: observaciones del backend, normalización sin
inventar evidencia, métricas frente a referencias y prueba del contrato P12.
Las revisiones de referencia son `main` en
`8f520a797c3470c1e2a53d86673ef6694dd3105c` y la infraestructura experimental
de #394 en `2ca8ccf248d4fe38caa664ec7442332a59160353`. La segunda se fusionó
después como `3f98b485` sin cambios en `shared/`; aquí sigue siendo una
candidata medida, no la referencia de lo que debe integrarse.

## Entradas y referencias

Se fijan 62 entradas antes de ejecutar los candidatos: 30 fragmentos GTZAN
(índices 0, 1 y 2 de diez géneros), los doce Ballroom del diagnóstico anterior,
17 señales de ritmo y tres señales de estructura. GTZAN separa diez casos de
desarrollo y veinte de test; no se ajustan modelos con esas particiones.
Ballroom permanece como diagnóstico ya visto y se declara el solapamiento de
entrenamiento por método. Las señales de estructura solo preparan P13.

`prepare.py` descarga fuentes, pesos de Beat This! y GTZAN en revisiones
fijadas. El audio Ballroom procede del archivo del concurso original y no se
redistribuye. `corpus.py` requiere su manifiesto local con `file`, `genre` y
`annotation`; su generador sintético está fijado a #394. El manifiesto registra
los SHA256 de audio y anotaciones. El proceso de referencia usó NumPy 1.26.4
para sintetizar; otro entorno no debe sobrescribir un manifiesto congelado.
El hash del manifiesto original identifica también sus rutas absolutas. En
otra ubicación se comparan los identificadores y hashes de audio/anotación;
los archivos de referencias exportados normalizan las rutas a nombres locales.

Las tolerancias son 70 ms para referencias musicales reales y 10 ms para
ataques sintéticos conocidos. El emparejamiento maximiza aciertos uno a uno
y después minimiza el error temporal. La tolerancia incluye su borde
matemático, con 1 ns para representación binaria. La ventana anotada conserva
ese margen en sus extremos. Sin anotación de subdivisión no se puntúa esa
subdivisión. Ausencia de anotación y ausencia explícita de compás son distintas.

## Ejecución

Los entornos son desechables y separados del `.venv` del motor. Los paquetes
y pesos grandes se preparan antes de medir. El directorio de trabajo de
Spleeter debe ser el del experimento para que encuentre sus pesos preparados.

```sh
DJ_LAB=/ruta/al/experimento
uv venv --python 3.11 "$DJ_LAB/venv"
uv pip install --python "$DJ_LAB/venv/bin/python" \
  -r docs/dj/detector_comparison/locks/python311.txt \
  --extra-index-url https://download.pytorch.org/whl/cpu --index-strategy unsafe-best-match
"$DJ_LAB/venv/bin/python" -m docs.dj.detector_comparison.prepare "$DJ_LAB"
uv pip install --python "$DJ_LAB/venv/bin/python" --no-deps \
  "$DJ_LAB/sources/CPJKU_beat_this" "$DJ_LAB/sources/mjhydri_BeatNet" "$DJ_LAB/sources/mir-aidj_all-in-one"
NATTEN_N_WORKERS=1 MAX_JOBS=1 uv pip install --python "$DJ_LAB/venv/bin/python" \
  --no-deps --no-build-isolation "$DJ_LAB/sources/CPJKU_madmom" natten==0.15.1
"$DJ_LAB/venv/bin/python" -m docs.dj.detector_comparison.corpus "$DJ_LAB" --ballroom-manifest /ruta/manifest.json
OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMBA_NUM_THREADS=1 \
  "$DJ_LAB/venv/bin/python" -m docs.dj.detector_comparison.run "$DJ_LAB" beatthis-small0-direct
```

Los cuatro locks registran los entornos ejecutados; no modifican
`requirements.txt` del motor. La compilación de madmom/NATTEN necesita un
compilador y la importación offline de BeatNet requiere PyAudio/PortAudio.
La preparación de pesos de HTDemucs, All-In-One y Spleeter y sus hashes queda
en el manifiesto de activos del informe. No iniciar un cronómetro mientras
se descargan pesos. El fork madmom-modern y las comprobaciones Python 3.14
usan sus respectivos entornos. Spleeter usa Python 3.8, su lock y el directorio
`pretrained_models/5stems` preparado antes de medir.

Después de crear los dos entornos necesarios, `prepare ROOT
--separated-weights` descarga los ocho checkpoints Harmonix en la revisión
fijada y usa los proveedores originales de HTDemucs y Spleeter para preparar
sus pesos. Ejecutar antes del cronómetro; contrastar sus archivos con los
hashes del informe. Beat Transformer y BeatNet+ incluyen sus pesos en las
fuentes congeladas.

Ejecutar **un método cada vez**, con CPU y un hilo. `run` hace dos pasadas por
entrada, guarda predicciones y activaciones comprimidas y registra errores,
carga, tiempos de CPU/pared, carga del modelo y pico de RSS. Un fallo no se
convierte en abstención musical. Tres fallos consecutivos interrumpen esa
configuración y quedan visibles. Los resultados existentes no se sobrescriben
salvo `--overwrite`; una corrección del evaluador se aplica a la salida retenida.
El runner rechaza reutilizar una carpeta de resultados con otro manifiesto.
Un cambio de pesos, configuración o entorno requiere otra carpeta de experimento;
`--overwrite` sirve para repetir el mismo manifiesto, no para mezclar cohortes.
Los temporales de Python y de sus hijos van a `ROOT/temporary`; los datos y
entornos grandes pueden residir en otro disco conservando enlaces simbólicos.
Se comprueba que quede al menos 1 GiB antes de comenzar una entrada nueva.

`decode` consume las activaciones originales con un único DBN de agrupaciones
2/3/4/6. Cambia el posprocesado, no repite ni altera la red. Sus tiempos miden
solo el decoder; conserva por separado los del pipeline original. No se debe
presentar ese tiempo pequeño como latencia total de un nuevo detector.

```sh
"$DJ_LAB/venv/bin/python" -m docs.dj.detector_comparison.decode "$DJ_LAB" beatthis-small0-direct
"$DJ_LAB/venv/bin/python" -m docs.dj.detector_comparison.report "$DJ_LAB" "$DJ_LAB/comparison-results.json"
"$DJ_LAB/venv/bin/python" -m pytest -q tests/test_dj_detector_comparison.py
```

`report` recalcula métricas desde los eventos guardados y aplica el mismo
ajuste de ataques de P1 a todos. No cambia octava ni pulso para corregir a un
backend. Se publican ambas salidas; el percentil temporal de los eventos
acertados no oculta las omisiones, que siguen en recobrado/F1 y continuidad.
Los intervalos bootstrap describen esta muestra pequeña; no eliminan su sesgo
ni prueban generalización a todas las músicas.

## Beat This! sin PyTorch

`onnx_probe.py` comprueba el runtime propuesto para integrar. `export` corre
en el entorno del laboratorio con PyTorch y `beat_this`; `--sliced-attention`
exporta la misma atención por banda y por cabeza para no materializar todas
las matrices a la vez. `run` usa un entorno limpio con solo NumPy y ONNX
Runtime y compara contra los `.npz`/`.json` retenidos de `beatthis-*-direct`.

```sh
uv venv --python 3.13 "$DJ_LAB/onnx-runtime-venv"
uv pip install --python "$DJ_LAB/onnx-runtime-venv/bin/python" numpy onnxruntime==1.31.0
"$DJ_LAB/venv/bin/python" docs/dj/detector_comparison/onnx_probe.py export --sliced-attention \
  --checkpoint small0 "$DJ_LAB/checkpoints/small0.ckpt" \
  --checkpoint final0 ~/.cache/torch/hub/checkpoints/beat_this-final0.ckpt \
  --out "$DJ_LAB/onnx-sliced" --derivatives "$DJ_LAB/derivatives"
"$DJ_LAB/onnx-runtime-venv/bin/python" -I docs/dj/detector_comparison/onnx_probe.py run \
  --onnx "$DJ_LAB/onnx-sliced" --manifest "$DJ_LAB/corpus/manifest.json" \
  --derivatives "$DJ_LAB/derivatives" --results "$DJ_LAB/results" --output "$DJ_LAB/onnx-sliced/run.json"
```

`export` necesita el paquete `onnx` (1.17.0 en la corrida) junto a PyTorch
2.5.1. `memory` mide el pico de RSS de un proceso nuevo con una entrada
(`--onnx` para ONNX Runtime, `--checkpoint` para PyTorch); ejecutar una vez por
configuración. Los resultados se copian a `results/onnx-*`.

## Frontera P12 y límites de la comparación

`normalize` es el único adaptador experimental al contrato de #394. Los
eventos no proporcionan por sí solos una confianza de compás. Si el backend
no la define, permanece nula en bruto y pasa como evidencia cero a las guardas
existentes. No se convierten sigmoides en probabilidad musical calibrada.
La subdivisión y la unidad notada permanecen desconocidas cuando no se miden.

`pipeline` usa un runtime temporal y una SQLite por configuración. Inyecta
las medidas experimentales en la frontera de almacenamiento de #394, tras la
ejecución real del backend sobre AAC. Comprueba HTTP de fuentes, colocación,
reparación, legacy y refinado, estado frío/caliente, ausencia de decodificación
en caliente, respuestas compactas y el mismo plan en todas las entradas. No
sustituye la adquisición ni instala un detector en producción. Su registro
distingue adaptación/contrato de certificación musical de una mezcla.
También pasa al HTTP las salidas WAV del pulso uniforme y de los dos cambios
de compás, conservadas en la corrida principal. Registra si el plan promete
alineación de compases pese a no existir un primer tiempo identificable.

Los paquetes nativos, la precisión sobre música, el contrato del planificador,
los ejecutores web/Android y la escucha física son evidencias distintas.
Una inferencia correcta en Linux x86_64 no acredita ejecución en Windows,
macOS o ARM64. El informe registra las pruebas realizadas y las ausencias.
