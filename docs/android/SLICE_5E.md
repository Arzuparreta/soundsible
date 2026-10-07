# S5e: controles del coche durante DJ

CarDjTest2/0 HTTP/TLS; runner exit0 y APK/test APK/JVM54/lint sin CA temporal.
[evidence](evidence/s5e.json) registra revisión, hash y duración.

Core crea el programa DJ con dos decoders reales. Los browsers moderno y clásico
observan la canción dominante. Browse conserva token y claves de ocurrencia;
pausa/seek6000ms desde clásico, resume desde moderno, y la secuencia inversa
conservan DJ y producen PCM estéreo48k no silencioso.

El primer bloque falló por una comprobación incorrecta del test: source indica
tipo de archivo, no modo DJ. Se corrigió con aserciones independientes de modo,
token/claves y PCM. No fue un fallo del producto.

SameUID/AVD no prueba host Google Auto, UID externo, audio físico ni paridad
completa. Labels del programa activo y pérdida/reconexión siguen pendientes.
