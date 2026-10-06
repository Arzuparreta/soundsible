# S4d — escucha Live en MediaSession

`NativeLivePlayer` integra WHEP en el router estable del servicio: una salida nativa,
metadata de sala, pausa/play/volumen/stop/prepare y ownership de focus/noisy mediante
`ProgramAudioFocus`. No anuncia seek de Live. La recepción nunca alimenta el tap
post-DSP del programa. Diagnostics PCM permanece en proceso, sin JS ni IPC.

El comando privado liveListen cambia de backend y la selección canónica de una
canción devuelve a NORMAL. El primer recorrido detectó un fallo de producto:
faltaba anunciar SET_MEDIA_ITEM/CHANGE_MEDIA_ITEMS para que MediaSession aceptase
la selección de música local al escuchar Live. Estos comandos pasan por resolución
canónica del servicio; clientes externos siguen sin permiso CHANGE_MEDIA_ITEMS.

LivePeer retiene volumen antes de onTrack, permite diagnóstico sin silenciar la
salida y usa un proveedor interno de PCM para el emisor sintético independiente
del test. Producción continúa usando exclusivamente LiveProgramInput post-DSP,
sin captura de micrófono. Owner/detach se libera con ambos tipos de input.

Aceptación: Listener HTTP/TLS + Host HTTP/TLS + Relay HTTP/TLS + Input tres casos,
9/0, runner exit0; normal APK/test APK/JVM54/lint pasan sin CA temporal. Ver evidencia.
Listener usa una fuente sintética independiente y relay real: PCM recibido,
MediaSession play/pause/volume, Activity cerrada, stop/prepare nuevo y vuelta a
NORMAL. Con PCM Live recibido >500 RMS, LiveProgramInput devuelve silencio,
comprobando que la escucha no se convierte en fuente de emisión.

Focus/noisy están conectados al propietario probado de DJ; falta aceptación
específica de interrupción de Live. Tampoco hay escucha física, UI, socket/metadata
como guest, artwork ni recuperación automática de la conexión de media. No es
paridad ni regresión principal actual.
