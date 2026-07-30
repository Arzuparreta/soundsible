# Auto Mode / DJ — audit crítico y propuesta de rework

Fecha: 2026-07-30. Alcance: `ui_web/src/components/AutoMode.tsx`,
`ui_web/src/stores/index.ts`, `ui_web/src/lib/audio.ts`,
`ui_web/src/lib/generatedQueue.ts`, `shared/dj_engine.py`,
`shared/api/routes/discovery.py`.

---

## 0. Veredicto

La idea es buena y las piezas individuales están bien escritas. Lo que está mal
planteado es **el contrato entre ellas**. Hay tres decisiones de fondo que hacen
que el sistema sea frágil por construcción, y no se arreglan con parches:

1. **No existe el concepto de "tema comprometido".** El siguiente tema y su
   transición pueden cambiar 200 ms antes de que suene. Un DJ real se
   compromete: elige el siguiente tema, lo prepara, y a partir de ahí ninguna
   orden del público lo cambia — sólo cambia lo que viene *después*.
2. **La transición se dispara comparando `currentTime` con un `out_cue` que no
   sabe a qué canción pertenece.** No hay ninguna validación de que ese cue sea
   del tema que está sonando. Basta con que la cola se reordene para que el DJ
   corte una canción por la mitad.
3. **El mixer vive en tiempo de pared (`setInterval` + `performance.now()`) y no
   tiene máquina de estados.** Pausa, buffering, `ended`, `jumpTo` y errores no
   están contemplados: unos lo desincronizan y otros lo dejan colgado para el
   resto de la sesión.

A eso se suma que **cada interacción de UI dispara un replan destructivo del
servidor** que puede tardar decenas de segundos (el timeout del cliente son
90 s), vacía el mapa de planes y reconstruye la cola. De ahí la sensación de que
"cualquier cosa que tocas rompe el DJ": literalmente es así.

---

## 1. Lo que ves al hacer click en la barra del DJ

**Es un bug, y es trivial.** `AutoMode.tsx:372` pone `onKeyDown` en el `div`
raíz, y ese handler (`AutoMode.tsx:331-336`) hace:

```ts
else if (event.key.toLowerCase() === 'n') void actions.autoSkip();
```

Los eventos de teclado del `<input>` del command bar (y del buscador de
peticiones) **burbujean hasta ese div**. Solid delega `keydown`, así que llega
igual.

Consecuencia: **escribir cualquier mensaje al DJ que contenga una "n" salta de
canción**. "no pongas reggaeton" → tres skips. `ArrowUp`/`ArrowDown` mientras
escribes cambian el volumen. Es exactamente el síntoma que describes: tocas la
barra, empiezas a escribir, y la canción cambia "sola".

Falta el guardia estándar: ignorar el atajo si `event.target` es `input`,
`textarea` o `[contenteditable]`.

---

## 2. Fallos críticos, por capa

### 2.1 Planificación — el `out_cue` se aplica a la canción equivocada

`maybeStartDjTransition` (`stores/index.ts:774-795`) hace:

```ts
const plan = state.autoMode.plan[queueIdentity(next)]?.transition;
const triggerAt = plan.out_cue - 8;
if (pb.currentTime < triggerAt) return;
```

`out_cue` está expresado en la línea de tiempo del **tema saliente**, que el
servidor calculó encadenando la ruta (`dj_engine.order_route`: la transición del
item *i* se calcula entre el item *i-1* y el *i*). Eso sólo es correcto si la
cola sigue exactamente el orden de la ruta y el tema que suena es el predecesor
que el servidor asumió. Nada lo garantiza:

- **Refill (append)**: `applyPlan` en modo no-`replace` (`stores/index.ts:2403`)
  añade la ruta nueva **al final de la cola**, pero el servidor la planificó
  usando como semilla `snapshot.currentTrack` (`generatedQueue.ts:245-247`). El
  primer tema añadido lleva un `out_cue` calculado contra la canción que suena
  *ahora*, y se aplicará contra la que suene dentro de 4 temas. Si el tema que
  finalmente lo precede es más largo → **corte a mitad de canción**. Si es más
  corto → transición que nunca ocurre y corte seco al final.
- **Entradas manuales** intercaladas rompen la cadena igual.

No hay ninguna comprobación de sanidad: ni `out_cue` contra la duración real del
elemento, ni el id del tema saliente contra el que suena.

### 2.2 `out_cue = 0` — el DJ mezcla en el segundo 0

`dj_engine._fallback()` (`dj_engine.py:65-83`) se usa para cualquier preview no
cacheada. Con `duration_hint = 0` (habitual en items de discovery sin duración)
devuelve `outro_cue = 0`. Después, `plan_transition` (`dj_engine.py:289-291`):

```python
out_cue = min(proposed_out, max(0.0, duration - overlap - 0.5)) if duration else proposed_out
```

Con `duration = 0` → `out_cue = 0`. En el cliente: `0 - 8 = -8`, y
`pb.currentTime >= -8` **siempre**. Resultado: la transición arranca en el
instante en que empieza la canción. Es la explicación más directa de los
"cambios constantes de canción" y de los cortes sin sentido.

### 2.3 El evento `ended` durante una mezcla se salta un tema

Durante la mezcla, el elemento canónico sigue reproduciendo el **saliente**,
pero `onDominant` (`stores/index.ts:797-820`) ya movió `playback.index` al
entrante. Si el saliente termina antes de que acabe el overlap (garantizado
cuando el análisis es fallback y el clamp de duración no se aplicó, ver 2.2):

`onEnded` → `actions.next()` → `resetDjTransitionState()` (mata la mezcla que ya
suena) → `loadIndex(index + 1)`, que ya no es el entrante sino **el siguiente**.
Se pierde una canción entera y se oye un corte duro.

### 2.4 Pausar durante una preparación deja tocando el otro deck

`togglePlay` (`stores/index.ts:1561-1583`) llama a `audioService.pause()`, que
sólo pausa el elemento principal (`audio.ts:209-211`). El `djTimer` y el deck
secundario siguen vivos: a la hora programada **el deck entrante empieza a sonar
solo, con el reproductor en pausa**.

### 2.5 `jumpTo` deja el DJ colgado para siempre

Las tarjetas del runway llaman a `actions.jumpTo` (`AutoMode.tsx:662`), que va
directo a `loadIndex` (`stores/index.ts:1628-1630`). `loadIndex` → `audioService.load`
→ `cancelDjTransition()` cancela el audio, **pero no toca
`state.autoMode.transition`**, que se queda en `'preparing'` o `'mixing'`. Y
`maybeStartDjTransition` sale inmediatamente si el status no es `'idle'`
(`stores/index.ts:775`). A partir de ese click, **no vuelve a haber ni una sola
transición** hasta que hagas seek o next. `scheduledDjTransition` también se
queda con una clave zombi.

Sólo `next`, `seek` y `exitAutoMode` llaman a `resetDjTransitionState`. Cualquier
otra ruta que cancele el audio (load, prime, stop, fallo de reproducción) deja
los dos estados divergidos.

### 2.6 El mixer usa reloj de pared

`scheduleDjTransition` (`audio.ts:250-337`):

- `transitionAt = scheduledAt + waitSec * 1000` se fija **al programar**, hasta
  8 s antes. Cualquier buffering, pausa o seek del saliente en esos 8 s
  desincroniza el punto de mezcla. Para previews (streaming proxied) el
  buffering no es la excepción, es lo normal.
- `setInterval(..., 50)` + `gain.setValueAtTime` en cada tick, en vez de
  programar la curva una vez en el reloj del `AudioContext`. En una pestaña en
  background el timer se estrangula a 1 Hz → la mezcla se convierte en una
  escalera audible.
- `secondary.play()` puede ejecutarse **antes** de que aterrice el seek al cue
  (`audio.ts:267-278`): en el skip inmediato (delay 0) se oye la intro del tema
  entrante desde 0:00 y luego un salto.
- Al terminar: `primary.src = url` + seek a mitad de canción + `play()`
  (`audio.ts:312-335`). Eso es **una recarga completa del stream** en cada
  transición: re-buffering de preview justo después de la mezcla, y salta toda
  la maquinaria de `activeAttempt` / telemetría del store.
- `ensureGraph()` crea el `AudioContext` de forma perezosa **dentro de un
  `timeupdate`**, no en un gesto de usuario. Si el navegador lo crea suspendido y
  `resume()` falla, todo el audio pasa por un grafo mudo: **silencio total** a
  mitad de canción.

### 2.7 Cada interacción de UI = replan destructivo

`setAutoDirection`, `setAutoDjProfile`, `requestAutoTrack` y `cancelAutoRequest`
(`stores/index.ts:1388-1422`) llaman todas a `setProfile(...)`
(`generatedQueue.ts:159-165`), que fuerza `sync(force=true, replace=true)`:

- aborta el plan en vuelo,
- **reemplaza toda la cola futura generada**,
- y hace `setState('autoMode', 'plan', {})` (`stores/index.ts:2406`): el mapa de
  planes se vacía, incluido el del tema que ya se estaba preparando.

Si en ese momento había una transición armada, el audio sigue mezclando hacia un
tema que ya no está en la cola: `onDominant` sale por el `queueId !== next.queueId`
(`stores/index.ts:798`) y **no actualiza la UI**, pero las ganancias siguen
moviéndose y `onComplete` acaba cargando ese tema en el elemento canónico. Audio
y UI hablando de canciones distintas.

Y el replan nuevo trae un `out_cue` calculado desde `currentTime = 0` del tema
actual, mientras el tema lleva 3 minutos sonando → dispara al instante
(sección 2.1). **Tocar un botón de energía puede cortar la canción en el acto.**

El propio `AUTO_MODE_PLAN.md:18` dice "A change replans the *uncommitted*
runway". El código no implementa eso: replanifica todo.

### 2.8 Servidor: análisis síncrono y caro en la ruta caliente

`discovery_music_dj_plan` (`discovery.py:1246-1336`) llama a `_dj_item_analysis`
para la semilla, **hasta 12 candidatos** y cada petición. Cada uno sin caché es
un `subprocess.run(ffmpeg)` que **decodifica la canción entera** (timeout 180 s,
`dj_engine.py:127-147`) más una FFT completa. Todo síncrono, bloqueando el
worker de Flask. El cliente pone `timeoutMs: 90000` (`api.ts:760`), lo cual es
un reconocimiento implícito de que esto tarda muchísimo.

Con `rate_limit(60/min)`, una sesión donde el usuario toquetea controles llega
al 429 → `degraded` → reintentos con backoff → runway vacío → cortes.

Además: para decidir una transición sólo hacen falta **los últimos ~60 s del
saliente y los primeros ~60 s del entrante**. Decodificar el fichero completo es
entre 5 y 10 veces más caro de lo necesario.

### 2.9 Otros

- `onDominant` fija `currentTime` (`stores/index.ts:803`) pero el `timeupdate`
  del elemento canónico, que sigue en el tema saliente, lo pisa 4 veces por
  segundo: durante la mezcla la barra de progreso muestra el tiempo de una
  canción contra la duración de otra.
- `listeningLearning.update` (`stores/index.ts:2697`) acredita al tema entrante
  las posiciones del saliente durante toda la mezcla → envenena el aprendizaje.
- `overlapMs = Math.max(2500, ...)` (`audio.ts:285`): pulsar "siguiente" tarda
  ~1,25 s en actualizar la UI. Se siente como que el botón no responde.
- `enterAutoMode` sin nada sonando coge `state.library.find(...)`
  (`stores/index.ts:1302`): el primer tema de la biblioteca por orden de fichero.
  Arranque pobre para lo que se vende como un DJ.
- No hay tiempo mínimo de reproducción. Nada impide que un tema dure 20 s.

---

## 3. Diagnóstico de fondo

Los bugs de arriba son síntomas de cuatro decisiones estructurales:

| Decisión actual | Por qué falla |
|---|---|
| La ruta del DJ **es** `playback.queue` + un mapa lateral `autoMode.plan` con otra clave (`queueIdentity` vs `queueId`) | Dos fuentes de verdad que se desincronizan en cada replan |
| La transición se deduce de estado derivado (`currentTime` vs `out_cue`) | No hay forma de saber si ese cue es válido para lo que suena |
| El mixer es un `setInterval` sin máquina de estados | Cada evento externo no contemplado deja el sistema en un estado imposible |
| El servidor planifica y analiza en la misma petición síncrona | La latencia del análisis se convierte en latencia de la interacción |

---

## 4. La propuesta

### 4.1 Punto de compromiso (lo más importante)

Un único concepto nuevo que arregla la mitad de los síntomas:

```
DjSession = {
  playing:   { key, deck: 'a' | 'b' }
  committed: CommittedNext | null   // congelado, intocable
  runway:    PlannedTrack[]         // replanificable a voluntad
}

CommittedNext = {
  fromKey, toKey,            // ambos extremos, explícitos
  outCue, inCue, overlap, technique, rate,
  committedAt
}
```

Reglas:

- Se **compromete** el siguiente tema cuando faltan ~45 s para su `outCue`, o al
  pulsar "siguiente". Una vez comprometido, ningún replan, cambio de dirección,
  petición ni cambio de DJ lo toca. Se aplican al `runway`.
- La UI lo dice en claro: *"Aplicado a partir del próximo tema"*. Es honesto y
  es exactamente lo que hace un DJ de verdad.
- Una petición exacta entra en el runway con su ETA; nunca desplaza lo
  comprometido.

Esto convierte "cualquier cosa que toco rompe el DJ" en "lo que toco cambia lo
que viene después", que es la promesa correcta del producto.

### 4.2 Invariantes de seguridad (hoy no existe ninguna)

Antes de armar cualquier transición:

1. `committed.fromKey === key(tema sonando)`. Si no coincide → descartar y usar
   fade seguro. **Nunca** se dispara un cue de otra canción.
2. `outCue` dentro de `[15, realDuration - overlap - 1]` usando la duración
   **real del elemento** (`audioEl().duration`), no la del metadata. Fuera de
   rango → recalcular como `realDuration - overlap`, o fade seguro.
3. Tiempo mínimo por tema: no se permite transición automática antes del 60 % o
   90 s (lo que sea menor). Mata los cambios constantes de raíz.
4. El deck entrante debe tener `readyState >= 3` y estar posicionado en su cue
   antes de que la ganancia se mueva un dB.
5. `confidence < 0.35` (análisis fallback) → sólo `safe_fade` corto anclado al
   final real. Nunca beatmatching sobre datos inventados.

### 4.3 Mixer: máquina de estados sobre el reloj de audio

```
idle → armed → prerolling → crossfading → settling → idle
```

- Cada evento externo tiene una arista definida: `pause`, `seek`, `next`,
  `jumpTo`, `error`, `ended`, `exit`, `queue-replaced`. Una sola función
  `transitionTo()` con `assert` de estado, en vez de las 4 llamadas dispersas a
  `resetDjTransitionState` de hoy.
- El disparo se ancla al reloj del medio (`deck.currentTime`), no a
  `performance.now()`. Si el saliente se atasca, la mezcla se atrasa con él.
- Las rampas se programan **una vez** con `setValueCurveAtTime` sobre
  `audioContext.currentTime`. Fuera `setInterval`.
- `AudioContext` creado al **entrar** en Auto Mode (es un gesto de usuario), no
  dentro de un `timeupdate`.
- `pause()` y `setMuted()` del `audioService` operan sobre **ambos** decks.

### 4.4 Dos decks simétricos (la decisión de arquitectura a tomar)

Hoy hay un elemento canónico y uno auxiliar, y al final de la mezcla se copia la
posición de vuelta al canónico recargando el `src`. Eso es un re-buffering
garantizado en cada transición y salta toda la telemetría de `activeAttempt`.

Lo correcto son **dos decks simétricos que se alternan** (A→B→A) y un
`audioService.active()` que devuelva el que manda. Precio: el store deja de
poder asumir "hay un único `HTMLAudioElement`" — los listeners y
`updatePositionState` pasan a hablar con el deck activo.

Es el rework de fondo. Alternativa barata si se quiere evitar: mantener el
elemento canónico y aceptar el re-`src`, pero con `preload` completo del
entrante y sin pasar por `load()` de `audioService`.

> **Esta es la decisión que hay que tomar antes de escribir código.**

### 4.5 Servidor: separar analizar de planificar

- `/dj-plan` **no decodifica nada**. Responde en < 400 ms con lo que haya en
  caché; lo que falte va con `analysed: false` y transición conservadora
  declarada como tal.
- El análisis se encola en un pool con concurrencia limitada, y **por segmentos**
  (últimos 60 s del saliente, primeros 60 s del entrante vía `-ss`/`-t` de
  FFmpeg). 5-10× más barato, y es todo lo que la transición necesita.
- Un endpoint ligero `POST /api/discovery/music/dj-transition {fromKey, toKey}`
  (o un push por socket) refina la transición cuando el análisis está listo,
  **siempre antes del punto de compromiso**. Si no llega a tiempo, se compromete
  la conservadora. Nunca se degrada la experiencia por esperar.
- Presupuesto explícito y medido: plan < 400 ms, refinamiento < 10 s.

### 4.6 UI: intención, no mando a distancia

- El command bar y los selectores expresan **intención**, con debounce (≥1,5 s) y
  coalescencia. Un cambio jamás lanza un `replace` inmediato.
- Feedback honesto: *"desde el próximo tema"* / *"aplicado"*.
- El runway muestra el compromiso: **"Siguiente: X — mezcla larga en 1:42"**.
  Eso es lo que hace que se sienta un DJ y no una lista.
- Las tarjetas del runway no llaman a `jumpTo`. Son *"ponlo el siguiente"* o un
  skip con transición corta.
- Atajos de teclado con guardia de `input`/`textarea`/`contenteditable`
  (sección 1) — y mejor aún, sólo activos cuando el foco está en el contenedor,
  no en un campo.

---

## 5. Plan de rework por fases

**Fase 0 — parar la hemorragia** (1 commit, sin cambios de arquitectura)

- Guardia de `input` en el `onKeyDown` de Auto Mode.
- Invariantes 1, 2 y 3 en `maybeStartDjTransition`.
- Cancelación determinista: `pause`, `jumpTo`, `ended` durante mezcla,
  `queue-replaced` → resetear audio **y** estado juntos.
- `setAutoDirection`/`requestAutoTrack`/... dejan de hacer `replace` destructivo:
  sólo reescriben el runway no comprometido, con debounce.

Con esto los síntomas que describes desaparecen.

**Fase 1** — máquina de estados del mixer sobre el reloj de audio; ganancias
programadas; `AudioContext` en el gesto de entrada.

**Fase 2** — modelo `DjSession` con punto de compromiso; el `plan` lateral
desaparece y la ruta pasa a ser una estructura propia proyectada a la cola.

**Fase 3** — servidor asíncrono, análisis por segmentos, endpoint de
refinamiento.

**Fase 4** — decks simétricos (sólo si se acepta 4.4).

---

## 6. Lo que NO tocaría

Está bien y no es el problema:

- `shared/dj_engine.py` como analizador: FFmpeg → PCM → NumPy en memoria, caché
  versionada de features, nada de audio decodificado en disco. La decisión es
  correcta; lo que está mal es *cuándo* se ejecuta.
- La taxonomía de técnicas (`long_blend`, `bass_swap`, `filter_blend`,
  `echo_cut`, `structural_fade`, `safe_fade`) y el gating por confianza.
- `GeneratedQueueController` como dueño único del ciclo de vida
  (cancelación, resultados obsoletos, reintentos). Le falta la distinción
  comprometido/replanificable, no un rediseño.
- La composición visual de Auto Mode (portada, identidad, transporte, runway).
