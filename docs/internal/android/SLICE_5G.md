# S5g: confianza y artwork entre UIDs

CarExternal2 + CarLegacy2 + CarLibrary2,6/0 HTTP/TLS; runner exit0 y APK/test
APK/JVM54/lint sin CA. [Evidence](evidence/s5g.json) registra hashes y duración.

Probe incluido sólo en APK de tests: servicio en proceso de otro UID y listener
de notificaciones. Sin autorización, browse es rechazado. El sistema autoriza
al listener temporalmente; browse y lectura real de PNG mediante URI opaca
funcionan entre UIDs, mientras escritura permanece denegada. La autorización
se retira en finally. Probe Java usa únicamente APIs Android, sin dependencias
del APK principal ni credenciales/cookies.

En este AVD API36 la autorización del gestor de notificaciones no actualizaba
la lista secure antigua que consulta Media3. PlaybackService admite como respaldo
la confianza del gestor multimedia del sistema (API28+), únicamente cuando Media3
ha verificado paquete/UID. No se amplían permisos de cola privada.
[Contrato de identidad](https://developer.android.com/reference/androidx/media3/session/MediaSession.ControllerInfo#isPackageNameVerified()).

No prueba host Google Auto, DHU ni escucha física. Controles y revocación de URI
tras logout desde otro UID siguen pendientes; no paridad completa/release.
