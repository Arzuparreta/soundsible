# S2ab: retirada durante una respuesta pendiente de Radio/autoplay

Continuación de S2aa implementada y validada en emulador API36. No cambia
la decisión offline ni cierra paridad completa.

Añadir a la fixture aislada un control autorizado sólo por loopback + header
para retrasar una única respuesta ya calculada por el planner real. No sustituir
su cuerpo, selección ni lectura del Core. El control expone únicamente IDs locales
acotados y contadores pending/delivered; delay máximo cinco segundos, reset tras
cada caso, sin cookies ni metadata personal en logs. Probar que una llamada sin
autorización no puede controlar el retraso.

Con música adquirida sintética de la fixture, pausar programa a20s, activar Radio
o autoplay y esperar que el planner haya producido candidatos. Retirar por UI
un candidato local mientras su respuesta está pendiente. Verificar snapshot
privado sin archivo, retirada efectiva del servicio y ausencia permanente del ID
cuando llega la respuesta anterior y cuando se completa un refill nuevo.
Conservar key/identidad/pausa/posición de la actual y perfil/modo; ninguna respuesta
antigua debe abrir otra cuenta o cerrar un programa nuevo. Repetir HTTP/HTTPS y
Radio/autoplay; cleanup regenera sólo archivos sintéticos propios y restaura
preferencias/controles. No borrar una biblioteca personal.

Preparar assets antes de instrumentar. Guardar resultado específico y volver a
normal APK/test APK/JVM/lint sin CA temporal. Principal clean dc29b73 (49+restart2)
en ejecución: no modificar el artifact de esa ejecución ni confundir sus sources
con este slice. Ampliar la regresión después si se añaden casos instrumentados.

Después continuar Library/Discover/Settings, DJ, Live, Android Auto, firma/update;
PR/main/alpha sólo con los gates completos. No cerrar turno por slice.

Fixture implementada: delay de una sola respuesta real, autorizado y acotado;
GET stats expone IDs de candidatos y pending/delivered. Usa sleep cooperativo
gevent, como el servidor, para que DELETE/GET puedan avanzar mientras la respuesta
está retenida. Un sleep bloqueante bloqueaba también las consultas de observación;
la prueba detectó ese error y se corrigió el helper, sin modificar el planner.
Python WAV/FLAC: dos casos pasan en /tmp/soundsible-s2ab-planner-fixture.log.
Verifican control no autorizado/valores inválidos, DELETE real, respuesta antigua
con ID retirado, snapshot sin ID y plan nuevo sin ID. Ruff pasa.

Instrumentación trasladada a
[PlannerRetirementTest.java](../../android/app/src/androidTest/java/com/soundsible/android/PlannerRetirementTest.java)
tras principal clean dc29b73: ejecutar HTTP/HTTPS para ambos modos. Cuatro casos instrumentados HTTP/HTTPS Radio/autoplay pasan, cero fallos/errores/
omisiones, dentro de targeted6 en /tmp/soundsible-s2ab-native.log. Assets desde
4e04083 dirty=true. La eliminación se confirma mientras pending>0; plan viejo
entregado, refill nuevo, ausencia del ID local, key/programToken/pausa20s y modos
preservados, sin audio HTML. Cleanup restaura preferencia y regenera sólo música
sintética después de drenar respuesta pendiente. APK/test APK/JVM17/lint normales
pasan sin CA temporal. No aceptación acústica ni paridad completa. Próxima
principal ampliada53 + restart2 desde commit limpio todavía pendiente.
