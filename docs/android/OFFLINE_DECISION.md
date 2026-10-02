# Offline: decisión de producto pendiente

**No implementar todavía. Bloquea la primera alpha hasta resolverse.**
El usuario quiere estudiar escuchar durante un vuelo, pero aún no ha aprobado
ni el alcance ni su integración en la lógica/UI. La implementación iOS es una
referencia de código sin aceptación de dispositivo; no es una especificación
aprobada para Android.

## Diferencia que debe entender el usuario

Hoy «Descargar» adquiere música para la biblioteca **del servidor**.
Tener esa canción en un teléfono desconectado sería retener una copia local.
No mezclar la operación de servidor con disponibilidad en el dispositivo.
Una canción guardada/bookmark tampoco equivale a un archivo adquirido ni a una
copia offline. Referencias: `components/trackActions.tsx`, `collection.download`
y `collection.save` en los diccionarios, `stores` y `ios/App/Support/OfflineStore.swift`.

Hipótesis a evaluar, **no decisión ni control que implementar**: una acción
«Disponible sin conexión» sobre canciones/colecciones, con estado discreto en
contexto y gestión de espacio centralizada. Evitar dos botones llamados
«Descargar» y evitar duplicar playlists o crear una biblioteca paralela confusa.

## Preguntas para el estudio antes de decidir

- ¿Sólo canciones ya adquiridas, o preparar también selecciones aún no adquiridas?
  ¿Qué ocurre con previews, podcasts, radio y DJ cuando no hay servidor?
- ¿Disponibilidad explícita por canción/colección, caché automática, o ambas?
  ¿Cómo sabe el usuario que ha terminado de preparar el vuelo?
- ¿Qué UI muestra música disponible, parcialmente preparada y ausente? Probar
  con bocetos el menú actual y el recorrido antes/durante/después del vuelo.
- ¿Límite de espacio, cancelación, descargas parciales, integridad, deduplicación,
  colección que cambia y archivos que se eliminan en el servidor?
- ¿Datos necesarios para navegar/reproducir sin conexión? Mantener índices en
  disco y uso de memoria acotado, no otra biblioteca completa residente.
- ¿Cuenta/servidor cambiados, token revocado, logout, retención y sincronización
  de progreso/favoritos? Distinguir intención local de confirmación del servidor.
- ¿Qué acciones exigen red y cómo se explican sin llenar la UI de errores?
  ¿Qué información/analítica sale al reconectar?

## Salida obligatoria del estudio

Registrar una decisión fechada: **incluir**, **posponer** o **descartar**, con
motivo y aceptación del usuario. Si se incluye: concretar journeys, mocks UI,
modelo de disponibilidad/sync, API necesaria, almacenamiento, pruebas y slices;
implementarlos y validarlos antes de la alpha. Si se pospone/descarta: actualizar
los gates y explicar honestamente esa limitación sin anunciar offline musical.

La caché PWA actual es del shell, no música offline. La APK actual tampoco
reproduce música sin conexión: sólo puede arrancar su pantalla empaquetada.
