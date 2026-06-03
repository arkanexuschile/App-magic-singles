# Version 2026-04-29 - Price sync resilience and custom field filtering

## Cambios incluidos

- El modo "mi propio custom field" ahora procesa solo variantes con valor en el custom field configurado.
- Si se permite fallback a producto, tambien se consideran valores en el custom field del producto; si no, se descartan antes de generar historial.
- Todos los modos filtran candidatos antes del historial: custom con valor, metafield con valor, SKU con valor disponible y titulo no vacio.
- En custom y metafield, las variantes con meta key y valor se mantienen en el CSV aunque Scryfall no las encuentre, con estado `No encontrada`.
- El CSV agrega la columna `Meta`; se llena cuando el metodo de busqueda es metafield o cuando se usa "mi propio custom field", en los demas modos queda vacia.
- El historial es compatible con despliegues donde la columna `Meta` aun no fue migrada; en ese caso lee/escribe historial sin ese dato en vez de romper la vista.
- En SKU y titulo, las variantes sin match contra Scryfall no se agregan al CSV.
- Se agrego el log `[product-debug] custom scryfall candidate filter` con variantes cargadas, variantes candidatas y variantes omitidas por no tener el custom field.
- Se agrego el log `[product-debug] selected search method candidate filter` para ver cuantos productos/variantes entran por el metodo seleccionado.
- La etapa de actualizacion de precios ahora convierte fallos de transporte de Shopify en fallos por item, evitando que un request caido aborte toda la corrida.
- Se ampliaron los errores retryables de Shopify para cubrir `fetch failed`, `request to ... failed`, `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN` y `UND_ERR`.
- El CSV de historial ya no copia el mensaje global de la corrida a filas que no fallaron; el motivo global solo se usa como respaldo en filas con estado `failed`.

## Archivos principales

- `app/services/price-sync.server.ts`
- `app/services/price-sync-matchers/custom-field.server.ts`
- `app/services/sync-run-history.server.ts`
- `app/routes/app.price-sync.history-csv.tsx`
- `prisma/schema.prisma`

## Verificacion

- `npm run lint`
- `npm run build`
