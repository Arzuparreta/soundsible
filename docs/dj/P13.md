# P13: frases y secciones sobre los compases medidos

Aceptación física (2026-10-30): el usuario confirma que los cambios
funcionan como esperaba en su escucha real.

Antes de P13, `structure.py` contaba bloques fijos de ocho compases desde el
primer 1 de cada región y etiquetaba cada bloque con umbrales escritos a mano
sobre su energía (0,9, 0,95, 1,18, 0,72, 0,35 y 0,48). Frases y secciones
salían de la misma suposición, así que coincidían entre sí sin que ninguna
estuviera medida. P13 las mide sobre los compases de P12-b y separa tres cosas:

| Concepto | De dónde sale | Qué se guarda |
| --- | --- | --- |
| El 1 de cada compás | P12-b: Beat This! y su DBN, o compases enteros contados desde un 1 medido por el mismo pulso (`projected_bar`) | `metric_regions`, `downbeats` |
| Inicio de frase | Un cambio medido del arreglo en una línea de compás, o compases enteros desde uno | `phrases[]` con `evidence`: `boundary`, `counted` o `assumed` |
| Sección y su papel | Frases consecutivas con el mismo papel, medido con niveles en dB | `sections[]` con `label` (o `None`), `low_db`, `upper_db`, `starts_on_change` |

`ANALYSER_VERSION` pasa de 11 a 12: las medidas anteriores se invalidan y la
biblioteca se vuelve a analizar en segundo plano. El contrato con web y Android
no cambia: `analysis_summary` omite `phrases` y `sections` como antes omitía
`phrase_boundaries`, y los clientes solo ejecutan el plan.

## Medidas

**Niveles.** La FFT de 2048 muestras a 11 025 Hz que `features` ya calculaba
para el RMS y la planitud da ahora también la potencia de siete bandas de
octava (centros IEC 61260 de 63 Hz a 4 kHz; la última termina en 5 kHz, como
las demás medidas). El espectro medio y el flujo espectral de esa FFT ya no
tenían lectores y se retiran. Cada pulso recibe el nivel en dB de cada banda
(media de potencia de las tramas cuyo centro cae en el pulso) y dos agregados:
la banda grave, 44–177 Hz (las dos octavas más bajas: bombo y bajo), y las
octavas superiores, 177–5000 Hz. Cada compás es la **mediana de sus pulsos**:
un pulso de anacrusa (el bombo que vuelve en el cuarto pulso) o la cola de un
golpe no mueven el cambio a otro compás. Se vio en el prototipo con música de
la biblioteca: en «Do To Me (Extended Mix)» el bombo vuelve en el cuarto pulso
del compás 31 y el compás 32 ya está completo; con la media de las tramas el
cambio caía en el 31, con la mediana de los pulsos en el 32.

**Tramos.** Los compases se recorren por tramos continuos: regiones contiguas
con unos del modelo o proyectados. Un tramo termina en una región sin compás
ni proyección, o en el hueco entre la cabeza y la cola de una grabación larga.
El último compás de un tramo solo se cierra si la rejilla llega a su final
dentro de la cobertura medida. Nada se cuenta a través de un hueco.

**Cambio del arreglo.** En cada línea de compás se comparan los cuatro
compases anteriores con los cuatro siguientes, banda por banda. Hay cambio si
en alguna banda la diferencia de medias es al menos 3,01 dB (10·log₁₀ 2) y
supera tres errores estándar de esos ocho compases. Se conserva la línea con
el margen más alto en ±3 compases (la anterior en un empate): dos cambios
quedan al menos a cuatro compases y una rampa produce un cambio, no uno cada
pocos compases.

**Longitud de frase.** Por tramo: una longitud L divide al menos dos de los
intervalos entre cambios consecutivos, más de los que permite el azar (un
intervalo es múltiplo de L con probabilidad 1/L). La cola binomial se
multiplica por el número de longitudes probadas (Bonferroni), desde 4 compases
hasta un cuarto del tramo, y debe quedar por debajo de 0,0027 (tres errores
estándar a dos colas). Gana la cola más pequeña: cambios cada 16 compases dan
16, no 8 ni 4.

**Inicios de frase.** Cada cambio es un inicio (`boundary`). Entre cambios se
cuentan compases enteros desde cada uno, y hacia atrás desde el primero: con
la longitud medida (`counted`) o, sin ella, con ocho compases (`assumed`). Un
inicio contado a menos de cuatro compases del siguiente cambio se omite: ese
cambio cierra la frase. Así una extensión (8 + 8 + 10 + 8) o una fase que no
empieza en el primer 1 desplazan las frases siguientes. Un tramo sin cambios
cuenta ocho compases desde su primer 1, como antes, marcados como supuestos.

**Papeles**, por segmento entre cambios, con la banda grave frente al
segmento más fuerte de la canción en esa banda:

| Estado del pulso | Condición |
| --- | --- |
| Sin pulso grave | Al menos 10 dB por debajo (menos de la mitad de sonoridad: se duplica cada 10 fon), con más de tres errores estándar |
| Con pulso grave | Menos de 10 dB por debajo, con más de tres errores estándar |
| Ninguno de los dos | Hereda el estado del segmento anterior del mismo tramo, o ninguno |

| Papel | Condición |
| --- | --- |
| intro | Apertura de la canción: hasta que empieza el pulso grave o, si abre con él, mientras cada cambio solo añade sonido (alguna banda sube y ninguna baja) |
| outro | Cierre: desde que se para el pulso grave o, si cierra con él, desde donde cada cambio solo quita sonido |
| breakdown | Sin pulso grave |
| build | Sin pulso grave, justo antes de un drop, con las octavas superiores subiendo al menos 3,01 dB a lo largo del segmento y una pendiente mayor que tres errores estándar |
| drop | Con pulso grave tras un segmento sin él |
| body | Con pulso grave, en el resto |
| `None` | Estado desconocido, segmento de un compás o tramo sin ningún cambio medido |

Un salto de nivel por sí solo no produce un drop ni un breakdown: todo 6 dB más
alto o más bajo deja el pulso grave dentro de 10 dB. Los segmentos contiguos con
el mismo papel forman una sección; un límite de sección es un cambio de papel.

**Por qué estas constantes no son gusto.** 3,01 dB es duplicar o reducir a la
mitad la potencia de una banda: entra un sonido con al menos la potencia que ya
había, o sale la mitad. 10 dB es la mitad de sonoridad. Cuatro compases son
las cuatro observaciones que `metre` exige para una repetición y la frase más
corta que se resuelve. Tres errores estándar y 0,0027 son la convención del
repositorio. Las bandas son octavas normalizadas y la grave reúne las dos que
ocupan bombo y bajo. Ocho compases es el supuesto anterior: se conserva solo
como reserva marcada. Ninguna se ajustó con canciones; las señales sintéticas
de `tests/test_dj_structure.py` comprueban cada una con una respuesta conocida.

## Planificador

- **Llegada al drop** (`_drop_entry`): el final de la mezcla se busca primero
  entre inicios de frase medidos (`boundary` o `counted`), el más lejano antes;
  los supuestos solo si no cabe ninguno medido. El drop entrante es una
  sección medida (vuelta del pulso grave), no un tramo más fuerte.
- **Salida durante el outro** (`_structural_exit`): un outro medido puede ser
  largo. La salida puede caer en su comienzo o en cualquiera de sus inicios de
  frase, el más cercano al punto de salida habitual. Con solo su comienzo, un
  outro de media canción habría adelantado la mezcla a la mitad de la pista.
- **Antes del breakdown** y **mezcla larga** (`_section_run`) conservan su
  lógica sobre las secciones nuevas. `outro_cue` sigue siendo el primer inicio
  de frase unos 64 pulsos antes del último sonido.
- Las frases y secciones de una canción no se usan como confirmación mutua:
  las secciones empiezan en cambios medidos, que también son inicios de frase,
  y ningún plan exige que coincidan.

## Evidencia

`.venv/bin/python -I docs/dj/structure_probe.py --model --library DIR --limit 60`
escribe [p13-results.json](p13-results.json) (`ANALYSER_VERSION` 12). Un cambio
solo cuenta como acierto en su compás exacto. Las cuatro mediciones son
independientes:

**1. Error propio de la estructura** (eventos del modelo exactos, en sus
tramas de 20 ms; 96 compases por señal):

| Señales | Cambios acertados | Longitud de frase | Papeles |
| --- | ---: | --- | --- |
| Frases de 4, 8 y 16 compases desde los compases 4, 5 y 4; en 4/4, 3/4 y 6/8 (dos pulsos con puntillo) | 117/117, ninguno de más; desfase mediano ≤ 0,2 ms | 4, 8 y 16 medidas en los nueve casos; fase correcta (el compás 5 no es múltiplo de 8 desde el primer 1) | — |
| Extensión 8 + 8 + 10 + 8 | 10/10 | 8, con la frase de 10 compases conservada | — |
| Cambios sin longitud común | 8/8 | ninguna; ocho compases `assumed` desde cada cambio | — |
| Intro, body, breakdown, drop y body; en 4/4, 3/4 y 6/8 | 15/15 | — | 100 % de los compases, sin abstenciones |
| Body, breakdown, build, drop y outro | 5/5 | — | 100 % |
| Todo 6 dB más alto / más bajo durante 16 compases | 2/2 y 2/2 | — | 100 %: ningún drop ni breakdown |
| Bucle constante; melodía 1,6 dB más alta; fundido de 0,5 dB por compás durante 32 compases | 0 cambios en los tres | todo `assumed` | todo `None` (95 compases) |

**2. Error heredado de compases equivocados** (mismas señales, eventos
alterados): con todos los unos un pulso tarde, los 11 cambios aparecen a
+499,8 ms (exactamente el pulso de error) y la longitud de frase sigue siendo 8;
los papeles siguen al 100 %. Con compases de tres pulsos sobre música de cuatro,
la longitud medida pasa a 11 compases del modelo y el 82,1 % de los compases
conserva su papel. La estructura no corrige el 1: lo hereda tal cual.

**3. Red real** (Beat This! `final0` sobre las mismas señales a 22 050 Hz):
en 4/4, cambios acertados 22/22, 11/11 y 6/6 con uno de más en las dos primeras
señales, y longitudes 4, 8 y 16; en la señal de papeles toda la rejilla queda
medio pulso antes (−249 ms) y los cambios con ella, con los papeles al 100 %.
En 3/4 y 6/8 la red agrupa los compases de otra forma (P12-b: lee 3/4 en grupos
de cuatro y 6/8 a 180 BPM binarios); la estructura hereda ese error: cambios
perdidos (0/22 en las frases de cuatro compases, que dejan de estar a cuatro
compases del modelo) o longitudes falsas (4 en lugar de 8). Los papeles siguen
al 100 % en las tres métricas. El material ambiguo no da cambios ni papeles.

**4. Biblioteca, sin anotaciones** (60 grabaciones de hasta 8 minutos; 16
omitidas por durar más o menos de 30 s): mediana de 10,1 cambios por cada 100
compases. De 644 intervalos entre cambios consecutivos, el 44,6 % son múltiplos
de 4 compases (1/4 = 25 % si fueran al azar) y el 19,6 % de 8 (12,5 %); de 16,
el 3,4 %, por debajo de 1/16 porque la mayoría de intervalos son cortos. La
longitud de frase solo se establece en 3 de 108 tramos: en música real casi
todas las frases contadas son el supuesto de ocho compases desde cada cambio
(288 `assumed`, 39 `counted`, 736 `boundary`). Compases por papel: body 5011,
intro 611, outro 543, drop 528, breakdown 511, build 12, sin papel 200. Es
concordancia con la práctica de fraseo, no precisión: no hay referencia
anotada.

**Planificador y reproductores.** `tests/test_dj_structure.py` comprueba con
estas señales que el drop entrante acaba en una frase medida de la saliente
(compás 5 + 8n, donde contar desde el primer 1 daba 8n), que el supuesto sigue
sirviendo de reserva y que un tramo solo más fuerte no se toma como drop. El
caso `phase` de `test_measured_audio_sections_reach_route_and_refinement...`
lleva lo mismo por AAC → análisis con la red → SQLite → `dj-plan`,
`dj-transition`, `dj-place`, `dj-repair` y la ruta legacy, con el mismo plan en
todos. `dj_structural_plans.json` añade `measured-phrase-phase` y
`measured-phrase-before-assumed` (el final de la mezcla en 218,25 s, frase
medida, donde la supuesta más lejana era 224,25 s); los ejecutan el store web
y `ProgramDjPlanTest` de Android sin mover puntos ni acortar el solapamiento.

**Coste.** `_compose` sobre nueve canciones de la biblioteca (43,4 minutos,
mismos PCM y eventos, un hilo): 0,067 s por minuto de audio en `main` y 0,071
en esta rama; pico de memoria trazada 14,4 y 14,5 MiB. La red sigue costando
unos 4 s por minuto. La FFT de las medidas es la misma; solo añade la suma por
bandas y retira el espectro medio y el flujo.

## Límites

- Los cambios se miden con niveles por banda de octava. Un cambio solo
  armónico o de timbre con el mismo nivel por banda (otra progresión con los
  mismos instrumentos) no se detecta.
- Resolución de cuatro compases: de dos cambios más cercanos se conserva uno,
  y una frase más corta no se resuelve. Una rampa más lenta que 3 dB cada
  cuatro compases no produce cambio; una más rápida produce uno dentro de ella.
- Todo error del 1 o de la agrupación de P12 se hereda (medición 2 y 3). En
  un bloque sin compás con pulso estable, P12-b proyecta compases desde el
  siguiente 1 (`projected_bar`) aunque el compás haya cambiado dentro del
  bloque; la estructura cuenta sobre esos compases.
- En música real la longitud de frase casi nunca queda establecida: hay muchos
  cambios pequeños a distancias distintas. Las frases entre cambios son
  entonces el supuesto de ocho compases, marcado como tal.
- Un final que solo baja de nivel cuenta como outro aunque sea largo; por eso la
  salida puede caer en cualquier frase del outro, no solo en su comienzo. Una
  apertura sin bombo seguida de su entrada da intro y drop.
- Sin anotaciones de estructura de música real, sin comparación con otro
  detector de estructura (All-In-One no dio una salida útil en P12-a). Estas
  evidencias siguen pendientes; la aceptación física fue confirmada por el
  usuario el 2026-10-30.
