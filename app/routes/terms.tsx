import type { MetaFunction } from "@remix-run/node";

export const meta: MetaFunction = () => [{ title: "Terms of Service — Singles Magic: The Gathering" }];

export default function TermsPage() {
  const supportEmail = process.env.APP_SUPPORT_EMAIL || "contacto@arkanexus.cl";

  return (
    <main style={{ maxWidth: 820, margin: "40px auto", padding: "0 16px", lineHeight: 1.6 }}>
      <h1>Terms of Service — Singles Magic: The Gathering</h1>
      <p>Last updated: September 21, 2026</p>

      <p>
        By installing Singles Magic: The Gathering you authorize the app to access the Shopify
        Admin API scopes requested during OAuth, in order to create and update products, variants,
        prices, and inventory for your store.
      </p>

      <h2>Subscription and Billing</h2>
      <ul>
        <li>The app is billed through Shopify as a recurring charge of USD 19.99 every 30 days.</li>
        <li>A 7-day free trial applies. You can cancel at any time from the app or from Shopify.</li>
        <li>Charges are handled by Shopify; the app does not process payment data.</li>
      </ul>

      <h2>Merchant Responsibilities</h2>
      <ul>
        <li>Review imported products, prices, and inventory in your Shopify admin.</li>
        <li>Ensure you have the right to list the products you import.</li>
      </ul>

      <h2>Third-party Data</h2>
      <p>
        Card data and images come from Scryfall; reference prices come from Card Kingdom. The app
        depends on the availability of these services and of the Shopify platform. Disruptions may
        affect imports or price updates.
      </p>

      <h2>Limitations</h2>
      <p>
        The app is provided "as is". We are not liable for indirect damages arising from the use of
        imported data or prices.
      </p>

      <h2>Contact</h2>
      <p>
        Support: <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
      </p>

      <hr style={{ margin: "32px 0" }} />

      <h2>Términos del Servicio (Español)</h2>
      <p>
        Al instalar Singles Magic: The Gathering autorizas el acceso a los scopes de la API de
        Shopify solicitados durante el OAuth, para crear y actualizar productos, variantes, precios
        e inventario de tu tienda.
      </p>
      <h3>Suscripción y cobro</h3>
      <ul>
        <li>La app se cobra a través de Shopify como cargo recurrente de USD 19.99 cada 30 días.</li>
        <li>Incluye 7 días de prueba gratis. Puedes cancelar cuando quieras.</li>
        <li>Los cobros los gestiona Shopify; la app no procesa datos de pago.</li>
      </ul>
      <h3>Datos de terceros y limitaciones</h3>
      <p>
        Los datos e imágenes de cartas provienen de Scryfall; los precios de referencia de Card
        Kingdom. La app depende de la disponibilidad de estos servicios y de la plataforma Shopify.
        Se entrega "tal cual", sin responsabilidad por daños indirectos.
      </p>
      <p>
        Soporte: <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
      </p>
    </main>
  );
}
