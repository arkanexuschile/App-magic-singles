import type { MetaFunction } from "@remix-run/node";

export const meta: MetaFunction = () => [{ title: "Privacy Policy — Singles Magic: The Gathering" }];

export default function PrivacyPolicyPage() {
  const supportEmail = process.env.APP_SUPPORT_EMAIL || "contacto@arkanexus.cl";

  return (
    <main style={{ maxWidth: 820, margin: "40px auto", padding: "0 16px", lineHeight: 1.6 }}>
      <h1>Privacy Policy — Singles Magic: The Gathering</h1>
      <p>Last updated: September 21, 2026</p>

      <p>
        Singles Magic: The Gathering is a Shopify app that helps merchants list Magic: The
        Gathering single cards in their store. It reads card data from Scryfall, creates products
        and variants, applies prices, and can set inventory quantities.
      </p>

      <h2>Data We Process</h2>
      <ul>
        <li>Store domain and app session data required for authentication (OAuth).</li>
        <li>Product and variant data of the store (titles, SKUs, prices, inventory) to create and update listings.</li>
        <li>Public Magic: The Gathering card data from Scryfall (names, sets, rarities, prices, images).</li>
        <li>Card Kingdom reference prices, used as a pricing source.</li>
      </ul>

      <h2>How We Use Data</h2>
      <ul>
        <li>Authenticate the app installation per store.</li>
        <li>Create and update products, variants, metafields, and inventory for the merchant.</li>
        <li>Calculate and apply prices to the merchant's variants.</li>
      </ul>

      <h2>Data Sharing</h2>
      <p>
        We do not sell merchant or customer data. Card and price data is fetched from public
        third-party sources (Scryfall, Card Kingdom). No customer personal data is collected by
        this app.
      </p>

      <h2>Retention</h2>
      <p>
        Data is retained only as needed for app operation and legal compliance. Redaction and
        deletion requests are handled via Shopify compliance webhooks.
      </p>

      <h2>Contact</h2>
      <p>
        For privacy requests, contact: <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
      </p>

      <hr style={{ margin: "32px 0" }} />

      <h2>Política de Privacidad (Español)</h2>
      <p>
        Singles Magic: The Gathering es una app de Shopify que ayuda a los comerciantes a publicar
        cartas individuales de Magic: The Gathering. Lee datos de cartas desde Scryfall, crea
        productos y variantes, aplica precios y puede definir inventario.
      </p>
      <h3>Datos que procesamos</h3>
      <ul>
        <li>Dominio de la tienda y datos de sesión para autenticación (OAuth).</li>
        <li>Datos de productos y variantes de la tienda (títulos, SKU, precios, inventario).</li>
        <li>Datos públicos de cartas de Magic desde Scryfall (nombres, ediciones, rarezas, precios, imágenes).</li>
        <li>Precios de referencia de Card Kingdom, usados como fuente de precios.</li>
      </ul>
      <h3>Uso de los datos</h3>
      <ul>
        <li>Autenticar la instalación de la app por tienda.</li>
        <li>Crear y actualizar productos, variantes, metafields e inventario.</li>
        <li>Calcular y aplicar precios a las variantes del comerciante.</li>
      </ul>
      <h3>Retención y contacto</h3>
      <p>
        Los datos se conservan solo lo necesario para operar la app y cumplir obligaciones legales.
        Solicitudes de eliminación se gestionan vía los webhooks de cumplimiento de Shopify.
        Contacto: <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
      </p>
    </main>
  );
}
