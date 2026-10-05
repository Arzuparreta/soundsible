# S3b: ejecución DJ nativa

## Punto de partida

S3a entrega nivelación y salida PCM de un stream Media3: ver evidencia/s3a.json.
No entrega solapamiento, técnicas DJ ni emisión Live. Los planes NORMAL actuales
usan el servicio nativo y su runway; no confundir Radio con una sesión DJ.

## Contrato que debe implementar el siguiente bloque

Leer `ui_web/src/stores/dj.ts`, `lib/generatedQueue.ts`,
`lib/audio/contracts.ts`, `lib/audio/mixer.ts` y `lib/audio/graph.ts`.
El planner selecciona y describe transiciones; el servicio ejecuta cues,
preroll, rate, phase correction, pausa y cancelación aunque Solid esté suspendido.
Las técnicas son direct, safe_fade, structural_fade, bass_swap, filter_blend,
long_blend y echo_cut. El nombre de una técnica o un switch Core no prueba efecto.

La salida sigue teniendo un propietario y una MediaSession. Dos decodificadores
pueden ser entradas de una mezcla, pero no dos salidas audibles independientes.
Ambas entradas usan fuentes nativas privadas, preparación/reintentos acotados y
ocurrencias distintas; no exponer cookies ni abrir audio HTML en paralelo.
El stream final requiere nivelación por entrada, EQ/filtro/echo, mezcla y limiter,
con tap post-DSP/pre-volumen. Conservar NORMAL/offline/podcasts y focus/noisy.

Antes de elegir implementación, resolver en un spike ejecutable:

1. Decodificar dos fuentes reales y alinear muestras con un reloj de salida;
   comprobar backpressure, cambios de formato, pausa, seek y fin del saliente.
2. Mantener salida continua al cambiar dominancia y metadata. No liberar y
   recrear el dueño audible en cada edición de la ruta ni reiniciar el entrante.
3. Editar/replanificar sólo tramos no comprometidos. Occurrence keys, programToken,
   dirección vigente y fromKey gobiernan receipts/cancellation; un fallo entrante
   deja audible el saliente y conserva recuperación explícita.
4. Medir ambas frecuencias durante equal-power y comprobar técnicas/limiter sobre
   PCM, control OS, background y scope de cuenta. Después integrar UI/planner.

CompositionPlayer actual reconstruye holders al sustituir composiciones; sus
clases AudioGraph/PlaybackAudioGraphWrapper son package-private. S3a documenta
las APIs oficiales contrastadas. No asumir que una composición estática acepta
una ruta dinámica ni parchear librerías generadas para aparentar API pública.
AudioMixer público tampoco resuelve solo ownership, reloj y controles.

## Aceptación posterior

Sesión contextual/nueva, dirección, fuentes, requests, reordenar/repair, retries
temporales sin cortar lo actual, manual Next, pausa/seek, Activity/background,
cancelación y salida privada. Inventariar acciones actuales antes de declarar
paridad. Live escucha/emisión con listener independiente y Auto/DHU vienen
después; firma/update y gates completos permanecen obligatorios para alpha.

Este documento es contexto de continuación, no evidencia de DJ implementado.
