import type { MetaFunction } from "@remix-run/node";

export const meta: MetaFunction = () => [{ title: "Support" }];

export default function SupportPage() {
  const supportEmail = process.env.APP_SUPPORT_EMAIL || "support@your-domain.com";

  return (
    <main style={{ maxWidth: 800, margin: "40px auto", padding: "0 16px" }}>
      <h1>Support</h1>
      <p>Need help with setup or troubleshooting?</p>
      <ul>
        <li>Email: <a href={`mailto:${supportEmail}`}>{supportEmail}</a></li>
        <li>Response time target: 1-2 business days</li>
      </ul>
      <h2>Required Information</h2>
      <ul>
        <li>Shop domain</li>
        <li>Approximate date and time of the issue</li>
        <li>SKU examples affected by sync</li>
      </ul>
    </main>
  );
}
