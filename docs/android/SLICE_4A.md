# S4a: entrada del programa nativo a WebRTC

LiveInputTest3/0,12.817s; runner exit0, APK/test APK/JVM54/lint sin CA temporal.
NORMAL real HTTP y TLS más entrada sintética. [Evidence](evidence/s4a.json).
Dos tests Python verifican checksum, rechazo de bytes alterados, conservación de
JNI/otras clases y reconstrucción reproducible desde cache sin red.

GetStream WebRTC fijado por SHA256. Se sustituye únicamente su recorder Java
por un adaptador compatible con JNI; nunca crea AudioRecord ni solicita micrófono.
Los binarios nativos no cambian. Licencias/notas incluidas en assets del AAR
preparado; APK normal se vuelve a validar después de añadir esos assets.
[Dependencia y mantenimiento](../../android/third-party/webrtc/README.md).

LiveProgramInput consume el tap post-DSP/pre-volumen nativo en un worker, convierte
canales y resamplea mediante Media3 a estéreo48k. Buffer máximo1s, pause/logout
no entregan audio encolado. NativeProgrammeOutput recibe estado playing del servicio;
el recorder envía bloques10ms y ceros durante pausa, sin callbacks PCM a JavaScript.

Un peer codifica Opus y otro decodifica con AudioTrackSink. Con música Core real
mono16k, RMS recibido>500; volumen local0 no silencia emisión. Pause produce RMS<20,
resume recupera señal. Sin permiso de micrófono concedido.

Todavía no WHIP/WHEP relay, sala/chat/UI, lease/background/reconexión, DJ hacia
receptor ni aceptación de exclusión de Live recibido. No afirmar Live completo.
Siguiente: transporte WHIP/WHEP contra relay aislado y luego sala nativa end to end.
