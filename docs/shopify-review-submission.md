# Shopify App Review Submission Pack — Singles Magic: The Gathering

Copy/paste content and checklist for the Shopify App Store review of the store app
(client_id `1fef72d2b05300b517964b5676b93892`).

## 1) App Listing Copy

### App name
Singles Magic: The Gathering

### Tagline
Import Magic: The Gathering singles from Scryfall with prices, stock and metafields.

### Description (English)
Singles Magic: The Gathering helps stores list Magic: The Gathering single cards quickly.

How it works:
- Pick one or more editions and import the cards from Scryfall.
- Every card becomes a Shopify product with variants, metafields, image and price.
- Download an Excel catalog, mark the cards you own, set quantities, and import only those.
- Keep prices and inventory up to date from Card Kingdom reference prices.

Core benefits:
- List hundreds of singles without manual data entry.
- Consistent metafields (set, rarity, language, finish, collector number, Scryfall ID).
- Control exactly what gets published (draft or active).

### Descripción (Español)
Singles Magic: The Gathering ayuda a las tiendas a publicar cartas individuales de Magic: The Gathering rápidamente.

- Elige una o varias ediciones e importa las cartas desde Scryfall.
- Cada carta se crea como producto de Shopify con variantes, metafields, imagen y precio.
- Descarga un catálogo en Excel, marca las cartas que tienes, define cantidades e importa solo esas.
- Mantén precios e inventario actualizados con precios de referencia de Card Kingdom.

### Support contact
contacto@arkanexus.cl

## 2) Required URLs

- Privacy policy: `https://app-singles.arkanexus.cl/privacy`
- Terms of service: `https://app-singles.arkanexus.cl/terms`
- Support: `https://app-singles.arkanexus.cl/support`

## 3) Pricing (must match the code)

- Recurring charge: **USD 19.99 every 30 days**
- Free trial: **7 days**

## 4) Reviewer Notes (copy/paste)

```
Thank you for reviewing Singles Magic: The Gathering.

Test flow:
1. Install the app on the provided test store.
2. Open the app from the Shopify admin.
3. Go to "Import Set", search for a small edition (e.g. code "big" or "cmr"),
   pick a language and import a few cards as Draft.
4. Verify the products/variants created in Shopify (title, price, SKU, metafields, image).
5. Optionally go to "Import by Excel": download the catalog, mark the INCLUIR column
   on a few rows, add a quantity, and upload it back to create only those cards.
6. Billing: open "Subscription" and subscribe. The app runs in test mode during review,
   so no real charge is made. A 7-day free trial applies.

What the app does:
- Reads public card data from Scryfall and reference prices from Card Kingdom.
- Creates/updates products, variants, metafields and inventory via the Admin API.

Data and compliance:
- Privacy webhooks implemented: /webhooks/customers/data_request, /webhooks/customers/redact, /webhooks/shop/redact
- Public legal pages: /privacy, /terms, /support
```

## 5) Submission Checklist

1. Deploy the store config: `shopify app deploy --config singles`
2. In the Partner Dashboard (app `1fef72d2…`):
   - App URL: `https://app-singles.arkanexus.cl`
   - Redirect URL: `https://app-singles.arkanexus.cl/auth/callback`
   - Scopes: `read_products,write_products,write_inventory`
   - Privacy / Terms / Support URLs (above)
   - Distribution: Public
3. Listing: name, tagline, description (ES/EN), category, pricing (19.99 / 30d + 7-day trial),
   screenshots, optional demo video, support email.
4. Provide a development/test store with the app installed.
5. Confirm API health shows no breaking changes.
6. Submit for review.
