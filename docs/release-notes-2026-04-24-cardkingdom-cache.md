# Release Notes - 2026-04-24

## Card Kingdom: cache en BD con refresh horario (escalable multi-comercio)

Se implemento una arquitectura de cache centralizada para Card Kingdom enfocada en escalar bien cuando hay muchos comercios y/o multiples instancias del backend.

### Cambios principales

- Se agrego `cardkingdom` como `priceSource` en la app.
- Los precios de Card Kingdom ahora se consultan desde BD local en lugar de llamar al endpoint en cada sync.
- Se incorporo refresh automatico del pricelist cada 1 hora (configurable).
- Se agrego lock distribuido en BD para evitar refresh duplicado entre instancias.
- El scheduler intenta refresh en cada tick, pero solo refresca cuando corresponde por TTL y lock.

### Nuevas tablas

- `CardKingdomPriceCache`
  - Guarda precios por `scryfallId` (`nonfoilPrice`, `foilPrice`) y metadata de snapshot.
- `BackgroundJobLock`
  - Lock distribuido para jobs de background (`jobKey`, `lockToken`, `lockedUntil`).

### Migraciones agregadas

- `20260423123000_add_cardkingdom_price_cache`
- `20260423131500_add_background_job_lock`

### Variables de entorno nuevas/relevantes

- `CARDKINGDOM_SYNC_INTERVAL_MS` (default: `3600000`)
- `CARDKINGDOM_DB_MEMORY_CACHE_TTL_MS` (default: `300000`)
- `CARDKINGDOM_REFRESH_LOCK_LEASE_MS` (default: `300000`)
- `CARDKINGDOM_PRICELIST_URL` (default: `https://api.cardkingdom.com/api/pricelist`)
- `CARDKINGDOM_PRICELIST_FALLBACK_URL` (default: `https://api.cardkingdom.com/api/v2/pricelist`)
- `CARDKINGDOM_PRICELIST_CACHE_TTL_MS` (alias legacy de `CARDKINGDOM_SYNC_INTERVAL_MS`)

### Impacto operativo

- Menos dependencia del endpoint externo durante sync de productos.
- Menor probabilidad de rate-limit o fallos por concurrencia.
- Mejor comportamiento en despliegues horizontalmente escalados.

### Despliegue recomendado

```bash
npx prisma migrate deploy
npx prisma generate
npm run build
pm2 restart <proceso> --update-env
```

### Archivos principales tocados

- `app/services/price-sync.server.ts`
- `app/services/sync-scheduler.server.ts`
- `app/routes/app.price-sync.tsx`
- `app/utils/i18n.ts`
- `prisma/schema.prisma`
- `prisma/migrations/20260423123000_add_cardkingdom_price_cache/migration.sql`
- `prisma/migrations/20260423131500_add_background_job_lock/migration.sql`
- `README.md`
