import type { MetaFunction } from "@remix-run/node";

export const meta: MetaFunction = () => [{ title: "Terms of Service" }];

export default function TermsPage() {
  const supportEmail = process.env.APP_SUPPORT_EMAIL || "support@your-domain.com";

  return (
    <main style={{ maxWidth: 800, margin: "40px auto", padding: "0 16px" }}>
      <h1>Terms of Service</h1>
      <p>Last updated: February 20, 2026</p>
      <p>
        By installing this app, you authorize it to access the Shopify Admin
        API scopes requested during OAuth and to update variant prices based on
        configured synchronization rules.
      </p>
      <h2>Merchant Responsibilities</h2>
      <ul>
        <li>Provide accurate external price data.</li>
        <li>Verify updates in your storefront and admin.</li>
      </ul>
      <h2>Limitations</h2>
      <p>
        The app depends on third-party API availability and Shopify platform
        APIs. Service disruptions can affect synchronization.
      </p>
      <h2>Contact</h2>
      <p>
        Support: <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
      </p>
    </main>
  );
}
