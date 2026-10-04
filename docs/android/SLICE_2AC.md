# S2ac: Settings de cuenta compartido con Android

Primer vertical de Settings; no sustituye la matriz completa. Extraer la sección
Account existente a una vista compartida sin stores de audio, con usuario,
operaciones y preferencias inyectadas. Web mantiene su adaptador actual; Android
usa transporte nativo, cuenta/generación/epoch y cancelación. Mantener etiquetas,
confirmaciones y filas originales: nombre visible, username, password, historial
de búsqueda y logout. No mostrar categorías con acciones todavía inexistentes.

Confirmar perfil desde respuesta y auth/state; rechazar respuesta vieja/cuenta
cambiada antes de escribir UI. No perder keys, pausa20s, programa, perfil ni copias
por cambiar nombre. Cambio de password usa cookie nativa/Keystore, nunca logs ni
state público; demostrar login real con nueva contraseña y restaurar sólo la
cuenta de fixture. Logout conserva su política actual de cierre/cancelación.

Historial compartido mediante storage inyectado: namespace origen+cuenta Android,
misma semántica de web (off elimina recents, máximo8, deduplicación). Discover
nativo debe usar esa misma preferencia y mostrar recents ejecutables; sin red no
crea una búsqueda ni recuerda otra cuenta. No reutilizar userKey web global de
una sesión distinta ni mezclar dos servidores con un mismo ID local.

Tests: shared view cancel/reject/confirm/stale/unmount y account namespace;
UI completa; APK HTTP/HTTPS con edición real, aislamiento, conservación de audio/
offline, Atrás y password/login/logout. Preparar assets antes de instrumentación,
retirar CA temporal y verificar normal APK/test APK/JVM/lint. Principal53+restart2
sobre03e3446 en curso; no cambiar sus fuentes nativas ni su artifact.

Después Appearance y secciones Settings restantes, Discover/entidades completas,
DJ/Live/Auto, firma/update, PR/main/release. No publicar alpha parcial ni cerrar
turno por este slice.

Implementación UI/controller en curso: AccountSettingsView compartida, storage
historial inyectado por origen/cuenta, guard de mutaciones confirmado por
receipt + auth/state no-store, SettingsAccount nativo con abort/lifetime y
confirmación. Discover nativo recuerda sólo respuestas vigentes y permite
repetir/retirar recientes; off limpia ambos dominios. UI completa1484/176 pasa en
/tmp/soundsible-s2ac-account-ui.log, incluidos cancel/reject/obsolete/unmount,
confirmación/password y aislamiento de historial. Recorrido APK aún pendiente.
No atribuir esta UI al artifact limpio03e3446 de la principal53.


## Recorrido nativo aceptado

HTTP/HTTPS2 pasa en /tmp/soundsible-s2ac-bootstrap-native.log; assets06004af
dirty=true. Cancelar nombre no escribe; nombre/username confirmados por snapshot,
username duplicado rechaza, password incorrecto conserva cookie y correcto rota
cookie cifrada. Conexión nueva descifra el valor Keystore; se observan conexiones
reales de eventos tras las mutaciones. Programa conserva key/programToken/pausa20s
y copia privada; recrear Activity conserva estado y sesión. Confirmación logout,
owner con preferencia propia y nuevo login member con username/password nuevos
prueban aislamiento y persistencia de historial. No cookies en logs/JS y no audio
HTML. APK/test APK/JVM17/lint sin CA temporal pasa.

Fallos corregidos durante aceptación: fila username incluye hint (localizador
exacto obsoleto); callbacks de test encapsulan const por evaluación WebView. La
salida Settings ahora respeta busy de revalidación igual que la cabecera, evitando
ofrecer una acción que leave() iba a ignorar. Test real de confirmación con
snapshots cambiados y test busy→ready pasan. Browser4 completo aceptado: Chromium278/66 y WebKit269/75, cero fallos;
logs /tmp/soundsible-s2ac-{chromium,webkit}.log. Principal55+restart2
posterior pendiente; último artifact limpio03e3446 tiene53+2 y no esta UI.

Este vertical no completa Settings: Appearance, roles/admin, dispositivos,
servicios y secciones restantes siguen pendientes, junto a Discover completo,
DJ/Live/Auto y firma/update. No equivale a una alpha.
