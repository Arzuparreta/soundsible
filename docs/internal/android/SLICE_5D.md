# S5d: cambios de copias locales en Auto

Bloque HTTP/TLS8/0,101.090s: CarOfflineExpiry2 + CarEvents2 + CarLibrary2 +
OfflineTest2. Extensión dirigida de prueba de completado CarEvents2/0,38.286s.
Ambos runner exit0, APK/test APK/JVM54/lint sin CA.
[evidence](evidence/s5d.json) identifica fuentes y alcance de ambos bloques.

OfflineStore publica señales nativas de completado/error, retirada, invalidación,
clear y cambios efectivos de etiquetas. No publica bytes/paths ni cada bloque de
progreso. Metadata idéntica no reescribe DB ni vuelve a notificar. Car subscriptions
observa sólo mientras hay suscriptores, agrupa refresh y elimina observer al reset/
close/último unsubscribe. La identidad incluye el perfil offline verificado cuando
no hay cookie; no abre socket de red sin cookie.

Con headers retrasados5s, se cierra Activity antes de completar la copia. Browser
recibe count1 al completarse y count0 al retirarse; programa NORMAL conserva KEY y
PCM. Con cookie expirada/backend503, una actualización de metadata del cache y
retirada también notifican. Esa actualización es el primitivo de cache local,
no una edición del servidor sin conexión. Al quedar sin copias, root se deniega;
logout y tests offline previos siguen pasando.

Pendientes controles/metadata durante DJ, pérdida/reconexión real y UID externo/
host. SameUID/AVD no prueba escucha o coche físico. No paridad completa/release.
