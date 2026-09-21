import type { MetaFunction } from "@remix-run/node";

export const meta: MetaFunction = () => [{ title: "Support — Singles Magic: The Gathering" }];

export default function SupportPage() {
  const supportEmail = process.env.APP_SUPPORT_EMAIL || "contacto@arkanexus.cl";

  return (
    <main style={{ maxWidth: 820, margin: "40px auto", padding: "0 16px", lineHeight: 1.6 }}>
      <h1>Support — Singles Magic: The Gathering</h1>
      <p>Need help with setup, imports, or troubleshooting?</p>
      <ul>
        <li>Email: <a href={`mailto:${supportEmail}`}>{supportEmail}</a></li>
        <li>Response time target: 1-2 business days</li>
      </ul>

      <h2>What to include</h2>
      <ul>
        <li>Your store domain (e.g. your-store.myshopify.com).</li>
        <li>Approximate date and time of the issue.</li>
        <li>What you were doing (e.g. importing a set, uploading the Excel catalog).</li>
        <li>The set code or a few product titles / SKUs involved, if relevant.</li>
      </ul>

      <h2>Quick help</h2>
      <ul>
        <li>Importing a set: go to “Import Set”, search the edition, choose the language, and import.</li>
        <li>Importing by Excel: go to “Import by Excel”, download the catalog, mark the rows you own with a value in the INCLUIR column, add stock in the cantidad column, and upload it back.</li>
        <li>Billing: manage or cancel your subscription from the “Subscription” page or from Shopify.</li>
      </ul>

      <hr style={{ margin: "32px 0" }} />

      <h2>Soporte (Español)</h2>
      <p>
        ¿Necesitas ayuda con la instalación, importaciones o solución de problemas?
        Escríbenos a <a href={`mailto:${supportEmail}`}>{supportEmail}</a> (respuesta en 1-2 días hábiles).
      </p>
      <p>Incluye: dominio de tu tienda, fecha y hora del problema, qué estabas haciendo y el código de set o algunos SKU involucrados.</p>
      <p>
        Ayuda rápida: “Importar Set” para traer una edición; “Importar por Excel” para descargar el
        catálogo, marcar la columna INCLUIR, poner stock en “cantidad” y volver a subirlo; y
        “Suscripción” para gestionar el plan.
      </p>
    </main>
  );
}
