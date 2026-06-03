# Shopify Price Sync - Guía en Español

Esta app sincroniza precios de variantes en Shopify usando datos de cartas de Scryfall.

## Flujo general

1. La app recorre variantes de productos.
2. Busca la carta según el método configurado.
3. Obtiene precio desde la fuente seleccionada.
4. Actualiza precios de variantes en Shopify.
5. Si eliges `CLP`, convierte el precio USD de Scryfall a pesos con fallback entre:
   - `https://mindicador.cl/api/dolar` (primaria)
   - `https://open.er-api.com/v6/latest/USD` (secundaria)
6. Antes de cada cambio de precio, guarda el valor previo en `custom.previous_price`.
7. En la primera inicialización de metadata, guarda `scryfall_meta` y opcionalmente imagen.

## Métodos de búsqueda

### 1) `sku`

Parsea el SKU con formato:

`[3 primeros caracteres edición][collector_number][foil/nonfoil o vacío][idioma]`

Ejemplos:

- `neo123foilen`
- `khm45nfen`
- `m2110es`

### 2) `title`

Busca por título del producto en Scryfall (modo exacto para juego físico).

### 3) `metafield`

Lee un metafield de la **variante** y usa ese valor como ID de carta en Scryfall.

Configuras en el panel:

- `Search metafield namespace`
- `Search metafield key`

Valor esperado:

- ID de carta Scryfall (UUID), por ejemplo:
  - `c2b9d0f1-5a2d-4b8b-9d2d-0f2a3b4c5d6e`

Importante:

- Estos campos solo se muestran cuando `search mode = metafield`.

## Campo interno `scryfall_meta`

En la primera inicialización de metadata, la app guarda el ID de Scryfall en:

- namespace: `custom`
- key: `scryfall_meta`

Este campo es interno y no se edita en el panel.

## Campo propio con `scryfall_id`

Opcionalmente puedes activar en el panel el modo para usar tu propio metafield:

- `Use my own Scryfall ID metafield`
- `Custom Scryfall ID namespace`
- `Custom Scryfall ID key`

Cuando está activo:

- la app usa ese campo para buscar precio en `scryfall` y `justtcg` (byExternalID),
- la app deja de escribir el campo interno `custom.scryfall_meta`.

## Programación diaria

En `/app/price-sync` puedes:

- activar/desactivar sincronización diaria,
- definir hora en UTC,
- elegir fuente de precio,
- elegir moneda objetivo (`USD` o `CLP`).

La sincronización recurrente actualiza **solo precios**.

## Fuentes de precio

- `scryfall`: activa.
- `justtcg`: activa por `byExternalID` usando `scryfall_id`.
- `mtgjson`: dummy.

## Moneda y precio previo

- `USD`: mantiene el precio original de Scryfall.
- `CLP`: convierte el precio USD usando fallback entre `mindicador.cl` y `open.er-api.com`.
- El tipo de cambio USD/CLP se cachea en base de datos (TTL por defecto: 24h).
- Si ambas APIs fallan, la app puede reutilizar temporalmente una tasa vencida (hasta 48h por defecto).
- Cuando el precio cambia, guarda el valor previo de la variante en `custom.previous_price`.
- El metafield de precio previo se guarda como `single_line_text_field` con formato decimal (`1234.00`).

Variables opcionales relacionadas:

- `EXCHANGE_RATE_CACHE_TTL_MS` (default `86400000`)
- `EXCHANGE_RATE_CACHE_MAX_STALE_MS` (default `172800000`)

## Imagen de producto

Si activas `sync image`, en la primera inicialización la app:

1. crea media con `image_uri` de Scryfall,
2. intenta mover esa imagen a la primera posición del producto.

## Comandos útiles

```bash
npx prisma migrate deploy
npm run review:check
npm run dev
```

## Requisito para revisión de Shopify

Define en producción:

- `APP_SUPPORT_EMAIL`

Ese correo se muestra en:

- `/privacy`
- `/terms`
- `/support`
