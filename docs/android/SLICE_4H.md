# S4h — Autorización y lease de sala Live

Host y guest esperan a que Socket.IO acepte la sala antes de abrir WHIP/WHEP.
La espera se limita a10s y se puede cancelar al salir/reset; rechazar el socket
no permite escuchar un stream público usando otra identidad de sala. Los
callbacks y las respuestas HTTP conservan ownership de generation/peer.

Un guest que pierde su socket durante10s termina la reproducción, retira el peer
y conserva el retry manual. Su estado conectado requiere tanto media como socket.
El host tiene el mismo límite de pérdida de lease. Los controles de fixture sólo
desconectan sockets reales de su sala/rol, sin exponer esta acción en producción.

La aceptación ampliada comprueba un guest con sala inexistente pero WHEP válido:
no debe decodificar PCM. Después escucha la sala correcta y ejecuta los controles
y la recuperación anteriores. Host y guest pierden sus sockets con Activity
cerrada; el audio Live termina, el host conserva el programa local y Community
retira la sala dentro de su gracia. Un test polling-only deja35s de silencio y
exige cero desconexiones, incluyendo el ping real del servidor a20s.

Validación: Host4/Listener2 pasan en el combinado9/2; los fallos fueron una
carrera del test UI al enviar chat antes de terminar el cambio de título y su
sala sin limpiar contaminando Polling. Corregidos sólo los tests, UI2/Polling1
pasan3/0, runner exit0 y normal APK/test APK/JVM56/lint sin CA. Producto
idéntico entre ambas ejecuciones. Ver evidence/s4h.json; no afirmar9/0 conjunto.
Todavía no es Live completo. Falta proceso/resume409, reset durante creación y
agotamiento de recovery. Un proceso muerto puede dejar ocupado el publisher en
MediaMTX mientras Core resume rota sus tokens: validar esta continuidad antes
de dar por implementado resume. No publicar ni integrar; revisión manual en PR.
