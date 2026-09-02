import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

import { authenticate } from "../shopify.server";
import { detectLanguage, i18n } from "../utils/i18n";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const lang = detectLanguage(request);

  return { apiKey: process.env.SHOPIFY_API_KEY || "", lang };
};

export default function App() {
  const { apiKey, lang } = useLoaderData<typeof loader>();
  const t = i18n[lang];
  const withLang = (path: string) => `${path}?lang=${lang}`;

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to={withLang("/app")} rel="home">
          {t.navHome}
        </Link>
        <Link to={withLang("/app/singles")}>{t.navSingles}</Link>
        <Link to={withLang("/app/sets")}>{t.navSets}</Link>
        <Link to={withLang("/app/bulk-import")}>{t.navBulkImport}</Link>
        <Link to={withLang("/app/price-sync")}>{t.navPriceSync}</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs Remix to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
