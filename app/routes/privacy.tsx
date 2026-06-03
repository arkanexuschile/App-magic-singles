import type { MetaFunction } from "@remix-run/node";

export const meta: MetaFunction = () => [{ title: "Privacy Policy" }];

export default function PrivacyPolicyPage() {
  const supportEmail = process.env.APP_SUPPORT_EMAIL || "support@your-domain.com";

  return (
    <main style={{ maxWidth: 800, margin: "40px auto", padding: "0 16px" }}>
      <h1>Privacy Policy</h1>
      <p>Last updated: February 20, 2026</p>
      <p>
        This app processes store and product data required to synchronize
        variant prices from an external source.
      </p>
      <h2>Data We Process</h2>
      <ul>
        <li>Store domain and app session data for authentication.</li>
        <li>Product variant identifiers, SKU, and price data.</li>
      </ul>
      <h2>How We Use Data</h2>
      <ul>
        <li>Authenticate the app installation per store.</li>
        <li>Match external prices by SKU and update variant prices.</li>
      </ul>
      <h2>Retention</h2>
      <p>
        Data is retained only as needed for app operation and legal compliance.
        Redaction requests are handled via Shopify compliance webhooks.
      </p>
      <h2>Contact</h2>
      <p>
        For privacy requests, contact: <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
      </p>
    </main>
  );
}
