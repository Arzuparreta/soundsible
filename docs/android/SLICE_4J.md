# S4j — Recovery del receptor, reset y foco del sistema

La aceptación utiliza el Community y MediaMTX reales del runner. Una intervención
sólo de fixture rechaza la autorización de lectura del stream seleccionado;
no sustituye el transporte, el socket ni la política de reintentos de Android.
Se observan exactamente cuatro intentos (inicial y tres reintentos), estado IDLE
con error y ausencia de más intentos. Retirar el rechazo y preparar/reproducir
manualmente restablece el receptor, conserva volumen y permite audio focus.

Un segundo propietario solicita foco transitorio mediante AudioManager: Live
queda suprimido conservando playWhenReady, y recupera reproducción cuando vuelve
el foco. Un broadcast del UID del sistema AUDIO_BECOMING_NOISY pausa; no deja el
receptor ni la sala y requiere reanudación explícita.

Durante OPTIONS TLS real detenido diez segundos, cerrar sesión retira el receptor
en menos de tres segundos. Ocho segundos después no hay reintentos ni recursos
WHEP, y preparar/reproducir el propietario de la generación anterior no lo reactiva.
La cuenta se restaura sólo para limpiar la sala de prueba con autorización firmada.

LiveRecoveryTest: HTTP y TLS, recovery y reset, cuatro pruebas sin fallos, 56.701s.
Registrar también salida del runner y checks normales en evidence/s4j.json.
No prueba acústica física ni regresión principal/browser completa. Agotamiento y
reset del publisher requieren aceptación separada; no declarar paridad completa.
