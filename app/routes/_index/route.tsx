import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, Link, useLoaderData } from "@remix-run/react";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Shopify Price Sync</h1>
        <p className={styles.text}>
          Sync product variant prices from an external pricing API, matched by SKU.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Automatic SKU matching</strong>. Import your external
            prices and update Shopify variants in batch.
          </li>
          <li>
            <strong>Multi-store architecture</strong>. Public app OAuth flow
            supports installation across multiple stores.
          </li>
          <li>
            <strong>Compliance ready</strong>. Includes privacy webhooks and
            public legal pages for review.
          </li>
        </ul>
        <p className={styles.text}>
          Legal: <Link to="/privacy">Privacy</Link> |{" "}
          <Link to="/terms">Terms</Link> | <Link to="/support">Support</Link>
        </p>
      </div>
    </div>
  );
}
