# Version 2026-04-30 - Shopify GraphQL reason y orden de modulos

## Cambios incluidos

- Se movio el cliente Admin API a `app/services/shopify/admin-client.server.ts`.
- Los errores HTTP/REST/GraphQL ahora incluyen `reason`, `operation`, `attempt`, `timeoutMs`, y cuando Shopify lo entrega, `requestId` y `retryAfter`.
- Si Shopify responde algo que no es JSON valido en GraphQL, el error ahora dice `Shopify GraphQL JSON response invalid` e incluye preview del body.
- Los errores GraphQL dentro de respuestas 200 ahora agregan contexto en las cargas grandes: operacion, chunk y cursor `after`.
- El cliente Shopify ahora respeta `Retry-After`, usa backoff exponencial con jitter y reintenta mas veces por defecto.
- Las respuestas GraphQL con errores retryables como throttle/rate limit se reintentan sin abortar la corrida completa.
- Las paginas grandes de variantes ahora hacen pacing con `extensions.cost.throttleStatus` antes de pedir la siguiente pagina.
- La pagina de variantes baja de 100 a 50 por defecto y queda configurable con `SHOPIFY_VARIANTS_PAGE_SIZE`; la validacion baja de 250 a 100 con `SHOPIFY_VALIDATION_VARIANTS_PAGE_SIZE`.

## Diagnostico para catalogos grandes

- En catalogos de 10k productos, la causa mas probable es que `syncCatalogWithScryfall` carga todas las variantes escaneables antes de aplicar el cursor o `maxProducts`.
- La query `SyncVariants` trae variantes con varios metafields de producto y variante; con 10k productos esto aumenta costo GraphQL, tiempo de respuesta y probabilidad de timeout/throttle.
- Si el nuevo `reason` muestra `operation=SyncVariants`, `status=429`, `retryAfter`, `timeout`, `request aborted by timeout` o JSON invalido, el problema esta en la etapa de carga del catalogo, antes de actualizar precios.
- El siguiente orden natural es paginar/seleccionar por productos desde Shopify antes de cargar todos los detalles, para que una corrida programada no necesite leer el catalogo completo.

## Archivos principales

- `app/services/shopify/admin-client.server.ts`
- `app/services/price-sync.server.ts`
- `app/services/sync-scheduler.server.ts`

## Verificacion

- `npm run lint`
- `npm run build`
