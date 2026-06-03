# Shopify App Review Submission Pack

This document contains copy/paste content and a final checklist for Shopify review.

## 1) App Listing Copy (English)

### App name
Shopify Price Sync

### One-line value proposition
Sync Shopify variant prices from your external pricing API using SKU matching.

### Full app description
Shopify Price Sync helps merchants keep product variant prices aligned with an external pricing source.

How it works:
- The app reads price records from your external API endpoint.
- Each record is matched to Shopify product variants by SKU.
- Matching variants are updated in batch through the Shopify Admin API.
- A sync summary is shown in-app (requested SKUs, matched variants, updated variants, and failures).

Core benefits:
- Reduce manual price updates.
- Keep multi-store pricing consistent.
- Improve accuracy with SKU-based matching.

### Support contact
Use the same email configured in `APP_SUPPORT_EMAIL`.

## 2) Required URLs (replace domain)

Use your production app domain:
- Privacy policy: `https://YOUR_APP_DOMAIN/privacy`
- Terms of service: `https://YOUR_APP_DOMAIN/terms`
- Support: `https://YOUR_APP_DOMAIN/support`

## 3) Reviewer Notes (copy/paste)

Use this in the "App review instructions" / "Notes for reviewer" field:

```
Thank you for reviewing Shopify Price Sync.

Test flow:
1. Install the app in the provided test store.
2. Open the embedded app and go to "Price Sync".
3. Click "Sync prices now".
4. Verify the success summary banner with counts for requested/matched/updated SKUs.
5. Confirm variant prices were updated in Shopify Admin for SKUs present in the external source.

What the app does:
- Reads price data from an external API configured by the merchant.
- Matches records by variant SKU.
- Updates variant prices through Admin GraphQL API.

Data and compliance:
- Privacy webhooks implemented:
  - /webhooks/customers/data_request
  - /webhooks/customers/redact
  - /webhooks/shop/redact
- Public legal pages:
  - /privacy
  - /terms
  - /support

No billing is required for this version.
```

## 4) Test Data Format

External API response must be JSON array:

```json
[
  { "sku": "TSHIRT-BLACK-S", "price": 19.99 },
  { "sku": "TSHIRT-BLACK-M", "price": 21.50 },
  { "sku": "TSHIRT-BLACK-L", "price": 22.00 }
]
```

## 5) Submission Checklist

1. Configure support email environment variable:
   - `APP_SUPPORT_EMAIL`
2. Ensure production env vars are set:
   - `EXTERNAL_PRICES_API_URL`
   - `EXTERNAL_PRICES_API_TOKEN` (optional)
   - `EXTERNAL_PRICES_API_TIMEOUT_MS` (optional)
3. Deploy app and config:
   - `npm run deploy`
4. Set app distribution to Public and visibility to Limited visibility.
5. Add URLs to Partner Dashboard:
   - Privacy policy URL
   - Terms of service URL
   - Support URL
6. Provide review assets:
   - Test store access
   - Short install/use video
   - Steps to trigger sync and expected results

## 6) Optional: Spanish Listing Copy

### Propuesta de valor
Sincroniza precios de variantes en Shopify desde tu API externa usando SKU.

### Descripción
Shopify Price Sync permite actualizar precios de variantes de forma masiva a partir de una API externa. La app obtiene registros con SKU y precio, hace matching contra variantes en Shopify y actualiza solo los precios que cambian. También muestra un resumen de resultados para validar el proceso.
