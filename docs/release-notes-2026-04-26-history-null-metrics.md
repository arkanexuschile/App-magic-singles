# Release Notes - 2026-04-26

## Historial de sincronizacion: evitar columnas en "-" por metricas nulas

Se corrigio un comportamiento en el historial de sincronizacion donde algunas corridas fallidas podian mostrarse con `-` en todas las columnas numericas (`escaneados`, `encontradas`, `actualizadas`, `fallos`).

### Causa raiz

En ciertos fallos tempranos (por ejemplo, problemas de sesion/token offline), la corrida se cerraba como `failed` sin `summary` numerico. Eso dejaba campos en `NULL` en `sync_run_history`, y la UI mostraba `-`.

### Cambios aplicados

- `finishSyncRunHistory` ahora completa resumen en `0` cuando una corrida `failed` no trae `summary`.
- `listRecentSyncRunsForShop` normaliza valores nulos a `0` al construir filas para la UI.
- Se mantiene el estado/diagnostico textual del run (`message`) para distinguir un fallo temprano de una corrida exitosa con cero cambios.

### Impacto

- El historial ya no queda con `-` en todas las columnas para corridas fallidas tempranas.
- Mejora la lectura operativa y evita confundir "sin datos" con "sin ejecucion".

### Limpieza de repositorio

- Se elimino `docs/apuntes.md`.

### Archivos tocados

- `app/services/sync-run-history.server.ts`
- `docs/apuntes.md` (eliminado)
- `docs/release-notes-2026-04-26-history-null-metrics.md`
