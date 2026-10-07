# Aislar presupuesto de login entre tests APK

La principal S2t terminó **35 tests, un fallo LibraryActions HTTP**, sin llegar a
restart ni rebuild normal. Connection y EntityBookmarks acumulaban suficientes
logins en la misma IP/ventana para que el login de owner de LibraryActions agotara
el límite real del motor (10/minuto). No era una pérdida de permiso ni de playlist.

Reproducción filtrada Connection + EntityBookmarks + LibraryActions: **ocho tests,
un fallo**, misma assertion owner y registro fixture **auth_login status=429**.
Logs `/tmp/soundsible-s2t-auth-repro.log` y
`/tmp/soundsible-auth-repro-fixture.log`. El registro sólo conserva status/time,
nunca contraseña, cookie o cuerpo. La auditoría se limita a 100 eventos.

FixtureIsolationListener limpia únicamente auth_login de esa IP al iniciar cada
caso JUnit independiente. Usa un cliente sin credenciales, HTTPS verificado y la
misma excepción cleartext privada; no cambia la conexión/preferencias de la app.
El helper integration instala ese listener; las dos fases persistentes offline
siguen su protocolo directo y no reinician almacenamiento entre ellas.

POST /__fixture/reset-auth-limit sólo existe en scripts/android_fixture.py,
requiere loopback y X-Android-Fixture=isolated, antes del lookup de cuenta para
admitir también el fixture passwordless. No toca cookies, cuentas ni otros límites.
El límite dentro de cada caso sigue activo; producción no cambia.

Python real confirma diez intentos erróneos 401, siguiente 429, reset sin cabecera
403/no efecto, auditoría protegida y reset explícito permite el siguiente login.
**Un test pasa** en `/tmp/soundsible-auth-fixture-test.log`. Repetición APK del
mismo grupo con aislamiento: **ocho tests, cero fallos/omitidos**, normal APK/test/
lint sin CA temporal pasa, `/tmp/soundsible-s2t-auth-isolated.log`. Ruff/diff pasan.

Repetir principal/restart sobre fuentes finales. Última global verde sigue S2q,
no presentar la corrección scoped como regresión completa. S2u selector OS tiene
contrato/draft separado, no forma parte de estos ocho tests ni de esta aceptación.
