# Release Notes - 2026-04-28

## Progreso colgado e historial de precios actualizados

Se corrigieron dos comportamientos relacionados con la visibilidad de sincronizaciones.

### Causa raiz

- El dashboard principal no ejecutaba la recuperacion de estados `running` obsoletos antes de mostrar el estado actual, por lo que podia seguir indicando una sincronizacion en progreso aunque el proceso ya no estuviera activo.
- Cuando una sincronizacion alcanzaba a aplicar cambios de precio y luego fallaba en una etapa posterior, el cierre del historial podia guardar un resumen vacio y dejar `actualizadas` en `0`.

### Cambios aplicados

- El loader del dashboard recupera estados `running` stale antes de leer la configuracion de sincronizacion.
- El cierre de historial conserva metricas ya persistidas cuando una corrida falla sin resumen final.
- El contador `pricesUpdated` usa como respaldo los items de historial con estado `updated` para evitar inconsistencias entre detalle y resumen.
- El CSV muestra `Sin cambios` para variantes cuyo precio ya estaba actualizado, aunque la corrida general haya terminado como fallida por una etapa posterior.
- La tabla en vivo muestra variantes escaneadas reales y refresca `encontradas`, `actualizadas`, `fallos` y `sospechas` con mayor frecuencia durante el avance de la sincronizacion.
- La validacion de metafields propios acepta IDs normalizados y URLs de carta de Scryfall, la modal de comprobacion se abre al iniciar la validacion y `custom.scryfall_id` consulta solo carta exacta y luego oracle ID.
- El boton `Comprobar contra Scryfall` muestra la modal y activa polling inmediatamente aunque el loader aun no haya recibido el estado de la cola.
- El envio de `Comprobar contra Scryfall` fuerza `intent=checkCustomScryfall` en el `FormData`, evitando que se procese como guardado de configuracion.

### Impacto

- El estado del dashboard se alinea mejor con la pantalla de sincronizacion.
- El historial conserva el numero de precios efectivamente actualizados aun si una etapa posterior falla.

### Archivos tocados

- `app/routes/app._index.tsx`
- `app/routes/app.price-sync.history-csv.tsx`
- `app/routes/app.price-sync.tsx`
- `app/services/price-sync.server.ts`
- `app/services/sync-config.server.ts`
- `app/services/sync-scheduler.server.ts`
- `app/services/sync-run-history.server.ts`
- `prisma/migrations/20260428010000_add_scheduled_suspicious_progress/migration.sql`
- `prisma/schema.prisma`
