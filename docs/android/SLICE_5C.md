# S5c: copias Auto después de expirar la cookie

**8/0 HTTP/TLS,60.403s**, runner exit0: CarOfflineExpiry2 + CarEvents2 +
CarLibrary2 + CarLegacy2. APK/test APK/JVM54/lint sin CA temporal pasan.
[evidence](evidence/s5c.json) conserva los hashes del código validado.

Una cookie expirada no equivale a una revocación observada. Conforme a Offline B,
el perfil local verificado puede servir únicamente copias completas. Su identidad
nativa deriva del perfil y no cruza IPC. Cache online anterior queda inválido;
root comprueba copias en worker y sólo expone «Disponible sin conexión». Carpetas
Core quedan denegadas y búsqueda sólo filtra copias completas. ProgramQueue comprueba
archivo/perfil antes de resolver reproducción. No adquisición ni red implícitas.
Sin cookie, artwork es placeholder, como exige Offline B.

La fixture desechable retima Set-Cookie, manteniendo HttpOnly/TLS. Native jar lo
consume; la Activity se destruye y APIs devuelven503. Tras expiry, browser obtiene
árbol local, reproduce archivo y busca/reproduce copia con PCM real. Root/acciones
online quedan denegadas y un título de otra cuenta no aparece. Logout borra copias
y programa.401 observado se valida en CarLibraryTest del mismo bloque.

No prueba revocación remota del token ni revalidación al recuperar el backend;
expira el cookie del cliente de forma controlada. Cambios de copias locales,
reconexión real, controles/metadata DJ y UID externo/host siguen pendientes.
No es paridad completa, release ni aceptación acústica/física.
