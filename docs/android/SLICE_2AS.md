# S2as — Continuación y retry del catálogo diferido

Un matcher400/404 retira sólo la ocurrencia pendiente y continúa hacia la
siguiente canción del programa, conservando la intención de pausa/play. No
interpreta fallos de autenticación, certificados o servidor como canción ausente.
Si no existe siguiente, detiene el programa.

El source pendiente dispone de su propia política acotada: dos retries para
429/5xx con Retry-After y presupuesto30s, y dos retries de socket/timeout. No
depende del observador de previews, que aún no tiene una identidad YouTube.
Al agotar, conserva la canción para Retry explícito. Las referencias pendientes
no se convierten en fuentes locales para requests/referencias DJ en menús.

DeviceCatalogSession HTTP/TLS2/0,51.339s prueba matcher404 seguido de PCM, dos
503 recuperados, tres intentos exactos agotados sin nuevos requests, Retry
explícito con PCM y reset durante matcher lento. WholeUI210/1617 + TS; fixture
Core1/0,22.89s. Regresión principal/browser4 y escucha física pendientes.

Runner exit0 y APK/test APK/JVM56/lint normales sin CA temporal pasan.
Log `/tmp/soundsible-catalog-recovery-native.log`; evidence/s2as.json.
