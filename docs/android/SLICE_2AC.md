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
repetir/retirar recientes; off limpia ambos dominios. UI completa1481/175 pasa en
/tmp/soundsible-s2ac-account-ui.log, incluidos cancel/reject/obsolete/unmount,
confirmación/password y aislamiento de historial. Recorrido APK aún pendiente.
No atribuir esta UI al artifact limpio03e3446 de la principal53.
