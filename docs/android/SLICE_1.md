# Primer slice funcional: conexión, cuenta y biblioteca real

## Resultado

Desde la APK local, elegir una instancia Soundsible, iniciar sesión y navegar la
biblioteca real con carátulas y eventos de actualización. No implementar todavía
reproducción, offline, DJ, Live, Android Auto ni publicación. La primera pantalla
conectada debe reutilizar la interfaz Solid existente, no un catálogo Android nuevo.

## Preparación técnica obligatoria

1. Revisar `apiOrigin`, `http.request`, `session`, `createSocket`, URLs de covers y
   streams, `/api/auth/*`, cookies, CORS y `on_socket_connect`. Caracterizar con
   fixture las cuentas single-user passwordless y multi-user member/admin.
2. Probar la sesión existente en transporte Android: login → `/api/auth/state`
   → recurso autenticado → socket con la misma cuenta → logout. La cookie es
   HttpOnly/SameSite=Lax; **no basta cambiar `same-origin` por `include`**.
3. Resolver el transporte nativo/cookie jar y Socket.IO de forma demostrable,
   manteniendo roles y scopes. Documentar la decisión técnica y pruebas en
   ARCHITECTURE antes de conectar todos los stores. Si necesita evolución API,
   mantener compatibilidad web/iOS y añadir pruebas de aislamiento/regresión.
4. Dar soporte explícito a HTTP privado/LAN y HTTPS remoto sin abrir tráfico
   arbitrario o navegación remota con acceso al puente. El emulador accede al
   host con `10.0.2.2`; su localhost no es el motor. Documentar Tailscale/LAN/DNS.

El login de cuenta es el camino inicial de paridad. El pairing limitado puede
ofrecerse después, pero no sustituye permisos de todas las acciones con un owner
token. La prueba de transporte es un gate funcional del slice, no justificación
para dejar la APK con un bypass de seguridad.

## Implementación

- Configuración de servidor con validación de URL y errores accionables. Guardar
  dirección sin credenciales; sesión y cualquier secreto en almacenamiento nativo
  protegido. Nunca persistir la contraseña de usuario.
- Adapter único para origen, sesión y recursos. Preservar abort/timeout/status,
  FormData, 304/ETags y aislamiento. No dispersar lógica Android en pantallas.
- Montar el cliente autenticado sólo tras resolver identidad. En servidor/cuenta
  cambiados, desmontar runtime, cancelar trabajos y resetear namespaces/caches
  antes de la siguiente cuenta; ignorar respuestas tardías.
- Biblioteca, navegación a colecciones y carátulas reales; eventos de cambios
  autenticados. Las acciones de audio aún pendientes no deben aparentar funcionar
  ni crear audio web por accidente. La limitación es de desarrollo, no una alpha.
- Logout, sesión caducada y red caída con recuperación explícita; volver a mostrar
  login/configuración según el motivo, sin borrado silencioso de datos válidos.

## Aceptación y entrega

Usar motor de prueba aislado, fixtures y dos cuentas. Probar conexión local HTTP y
remota HTTPS, passwordless, miembro y administrador, contraseña incorrecta,
servidor inaccesible, 401/403, expiración/revocación, reinicio, cambio de cuenta y
servidor con trabajos en vuelo. Verificar que REST, imágenes y eventos no filtran
datos entre cuentas ni credenciales a terceros. Probar cover relativa/externa,
lista vacía y reconexión con cambio de biblioteca. No exponer librería de otro
usuario durante boot ni dar por bueno sólo el happy path.

Pruebas unitarias/contrato, backend si cambia, cuatro perfiles browser completos
y APK empaquetada en emulador. Conservar comandos, build-info, logs sin secretos
y resultado. Actualizar matriz/HANDOFF y cerrar con commit enfocado, sin push,
PR o publicación salvo instrucción posterior. Si se abre PR: fetch/ancestry de
base actual y exactamente un impact label según AGENTS.

## Estado tras implementación

Núcleo funcional implementado y probado con APK/API 36 y motores desechables.
Ver [evidencia](evidence/s1.json) y [traspaso](HANDOFF.md). Sigue pendiente la
aceptación positiva contra una instancia HTTPS remota con certificado válido y
DNS/Tailscale reales. La superficie de lectura no afirma paridad de acciones.
El usuario autorizó push después de S0; PR/merge/publicación siguen sin solicitar.
Siguiente corte: [audio nativo S2](SLICE_2.md).
