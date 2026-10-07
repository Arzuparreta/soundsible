# S4b — relay nativo WHIP/WHEP

Implementa `LivePeer`, recurso WebRTC de publicación/recepción nativa con transporte
HTTPS sin cookies del Core, sin redirects y con Location restringida al mismo
origen. Descubre ICE con OPTIONS, negocia Opus estéreo con captura post-DSP y
publica la oferta completa después de reunir candidatos. DELETE libera el recurso.
Una reserva de publisher anterior a crear la captura impide que un segundo intento
robe el tap del programa activo. No se solicita acceso al micrófono.

`scripts/android_live_fixture.py` ejecuta Community real y MediaMTX fijado por digest
en un entorno efímero: base de datos privada, firma Ed25519 del Core, autenticación
HTTP de MediaMTX y TLS con la CA temporal del runner. No usa servicios públicos.
El alias 10.0.2.2→loopback afecta sólo al resolver del Core desechable para reproducir
la dirección del gateway del AVD, conservando hostname y verificación TLS.

El runner inicia el relay en la suite principal y cuando el filtro incluye
`LiveRelayTest`; también puede activarse con `SOUNDSIBLE_ANDROID_LIVE_FIXTURE=1`.
Requiere Docker. Los recursos se eliminan al finalizar, incluso ante fallo.

Validación dirigida: Core HTTP y TLS → sesión firmada → WHIP autenticado → MediaMTX
→ WHEP → PCM decodificado nativo. Verifica energía, mute local independiente,
pausa/silencio, reanudación, continuidad al cerrar Activity y rechazo de otro
publisher sin dañar la captura activa. El relay siempre usa HTTPS.

Esto todavía no conecta Live con los controles compartidos: faltan puente UI,
lease/socket y metadata de host en background, escucha integrada con MediaSession,
chat, reconexión y validación DJ a través del relay. Tampoco demuestra conectividad
STUN/TURN por Internet ni escucha acústica en hardware físico. No declara paridad.
