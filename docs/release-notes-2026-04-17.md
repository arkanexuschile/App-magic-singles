# Release Notes - 2026-04-17

Este documento resume los cambios implementados en la ultima version, incluyendo ajustes de scheduler, persistencia de metricas, manejo de throttling y nuevos campos de configuracion en UI.

## 1) Configuracion de alertas de precio sospechoso

Se agrego una configuracion en el panel de Price Sync para controlar la regla de variacion sospechosa:

- Checkbox: `Desactivar alerta de precio sospechoso`
- Input numerico: `Umbral de alerta sospechosa (%)`
  - Solo acepta numeros
  - Queda deshabilitado cuando el checkbox de desactivar alerta esta activo

### Campos nuevos en DB (SyncConfiguration)

- `disableSuspiciousPriceAlert` (Boolean, default `false`)
- `suspiciousPriceAlertThresholdPercent` (Float, default `50`)

### Migraciones agregadas

- `20260417190000_add_disable_suspicious_price_alert`
- `20260417203000_add_suspicious_alert_threshold`

### Comportamiento en sync

- Si `disableSuspiciousPriceAlert = true`, no bloquea actualizaciones por variacion alta.
- Si `disableSuspiciousPriceAlert = false`, usa `suspiciousPriceAlertThresholdPercent` en lugar de 50% fijo.

## 2) Scheduler: reintentos por throttling

Se agrego manejo explicito de errores tipo `Throttled`/`429` en corridas programadas:

- Reintentos automaticos por chunk con backoff
- No se pierde el avance acumulado entre intentos

## 3) Scheduler: preservar avance ante error

Se mejoro la persistencia para que ante fallos no se "reseteen" metricas:

- Si hay progreso parcial y ocurre error, se guarda `partialSummary`
- `markSyncRun` y `finishSyncRunHistory` reciben ese resumen parcial
- En reanudacion con cursor (`scheduledCursor*`), el run parte desde `currentScheduled*` existentes en vez de iniciar en cero

## 4) Historial y dashboard: evitar mostrar 0 falso

Cuando un run no tiene metricas finales (por ejemplo, fallo temprano), ahora UI muestra `-` en lugar de `0` en tablas de historial para evitar interpretaciones de "reseteo".

## 5) Tick scheduler en segundo plano

Mejora de robustez para ticks simultaneos:

- Si llega un tick mientras otro esta en ejecucion, se marca solicitud pendiente
- Al terminar el tick activo, se dispara automaticamente un nuevo tick
- Seleccion de tiendas due ordenada por `nextRunAt` ascendente

## 6) Variables de entorno nuevas/relevantes para ecosystem

### Nuevas para throttling/reintentos scheduler

- `SCHEDULED_THROTTLE_MAX_RETRIES` (recomendado: `5`)
- `SCHEDULED_THROTTLE_RETRY_BASE_MS` (recomendado: `5000`)

### Recomendadas anti-throttle (agresivas/conservadoras)

- `PRICE_UPDATE_PRODUCT_CONCURRENCY` = `1`
- `PRICE_UPDATE_BATCH_SIZE` = `10`
- `METAFIELD_UPDATE_BATCH_SIZE` = `10`
- `SCHEDULED_SYNC_MAX_PRODUCTS_PER_RUN` = `100`
- `SCHEDULED_SHOP_CONCURRENCY` = `1` (subir gradualmente a 2 o 3 si estable)

## 7) Bloques sugeridos para `ecosystem.config.cjs`

Agregar/ajustar en `env`:

```js
PRICE_UPDATE_PRODUCT_CONCURRENCY: "1",
PRICE_UPDATE_BATCH_SIZE: "10",
METAFIELD_UPDATE_BATCH_SIZE: "10",
SCHEDULED_SYNC_MAX_PRODUCTS_PER_RUN: "100",
SCHEDULED_THROTTLE_MAX_RETRIES: "5",
SCHEDULED_THROTTLE_RETRY_BASE_MS: "5000",
SCHEDULED_SHOP_CONCURRENCY: "1",
```

## 8) Despliegue recomendado

```bash
npx prisma migrate deploy
npx prisma generate
npm run build
pm2 restart <proceso> --update-env
```

## 9) Archivos principales tocados

- `app/routes/app.price-sync.tsx`
- `app/routes/app.price-sync.history-csv.tsx`
- `app/routes/app._index.tsx`
- `app/services/price-sync.server.ts`
- `app/services/sync-config.server.ts`
- `app/services/sync-run-history.server.ts`
- `app/services/sync-scheduler.server.ts`
- `app/utils/i18n.ts`
- `prisma/schema.prisma`
- `prisma/migrations/20260417190000_add_disable_suspicious_price_alert/migration.sql`
- `prisma/migrations/20260417203000_add_suspicious_alert_threshold/migration.sql`
