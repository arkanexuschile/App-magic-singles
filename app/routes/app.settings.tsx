import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  BlockStack,
  Card,
  Layout,
  Link,
  List,
  Page,
  Text,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { detectLanguage } from "../utils/i18n";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const lang = detectLanguage(request);
  return { lang };
};

export default function SettingsPage() {
  const { lang } = useLoaderData<typeof loader>();
  const isEs = lang === "es";

  return (
    <Page>
      <TitleBar title={isEs ? "Preparación Review" : "Review Readiness"} />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                {isEs ? "Checklist para Review de Shopify" : "Shopify Review Checklist"}
              </Text>
              <List>
                <List.Item>
                  {isEs
                    ? "Define distribución Public en Partner Dashboard."
                    : "Set app distribution to Public in Partner Dashboard."}
                </List.Item>
                <List.Item>
                  {isEs
                    ? "Usa visibilidad limitada si no quieres que aparezca listada."
                    : "Set visibility to Limited visibility if you do not want listing."}
                </List.Item>
                <List.Item>
                  {isEs
                    ? "Publica URLs de privacidad, términos y soporte."
                    : "Provide Privacy Policy, Terms, and Support URLs."}
                </List.Item>
                <List.Item>
                  {isEs
                    ? "Graba un video corto de instalación y sincronización."
                    : "Record install + sync flow video for the reviewer."}
                </List.Item>
                <List.Item>
                  {isEs
                    ? "Entrega tienda de prueba e instrucciones claras de test."
                    : "Provide a test store account and clear test steps."}
                </List.Item>
              </List>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingMd">
                {isEs ? "URLs públicas" : "Public URLs"}
              </Text>
              <Text as="p" variant="bodyMd">
                {isEs
                  ? "Configura estas rutas en los campos del listing:"
                  : "Configure these paths in your app listing fields:"}
              </Text>
              <List>
                <List.Item>
                  <Link url="/privacy" target="_blank" removeUnderline>
                    /privacy
                  </Link>
                </List.Item>
                <List.Item>
                  <Link url="/terms" target="_blank" removeUnderline>
                    /terms
                  </Link>
                </List.Item>
                <List.Item>
                  <Link url="/support" target="_blank" removeUnderline>
                    /support
                  </Link>
                </List.Item>
              </List>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
