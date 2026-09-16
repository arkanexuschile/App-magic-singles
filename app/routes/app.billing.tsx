import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { authenticate, MONTHLY_PLAN, isBillingTestMode, isBillingEnabled } from "../shopify.server";
import { getBillingStatus } from "../services/billing.server";
import { detectLanguage } from "../utils/i18n";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  if (!isBillingEnabled()) {
    throw redirect(`/app${new URL(request.url).search}`);
  }
  const lang = detectLanguage(request);
  const status = await getBillingStatus(request);
  return json({ lang, status });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { billing } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "subscribe") {
    await billing.request({
      plan: MONTHLY_PLAN,
      isTest: isBillingTestMode(),
    });
    return json({ ok: true });
  }

  if (intent === "cancel") {
    const status = await getBillingStatus(request);
    if (status.subscriptionId) {
      await billing.cancel({
        subscriptionId: status.subscriptionId,
        isTest: isBillingTestMode(),
        prorate: true,
      });
      return json({ ok: true, cancelled: true });
    }
    return json({ ok: false, error: "No active subscription" }, { status: 400 });
  }

  return json({ ok: false, error: "Unknown intent" }, { status: 400 });
};

export default function BillingPage() {
  const { lang, status } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ ok?: boolean; cancelled?: boolean; error?: string }>();
  const navigation = useNavigation();
  const isEs = lang === "es";
  const busy = navigation.state === "submitting";

  return (
    <Page>
      <TitleBar title={isEs ? "Suscripción" : "Subscription"} />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                {isEs ? "Plan de la app" : "App plan"}
              </Text>
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd">
                  <strong>{status.planName}</strong> — {status.currencyCode}{" "}
                  {status.amount} / {isEs ? "cada 30 días" : "every 30 days"}
                </Text>
                {!status.hasActivePayment && (
                  <Text as="p" variant="bodyMd" tone="success">
                    {isEs
                      ? "Incluye 7 días de prueba gratis. No se cobra nada durante la prueba."
                      : "Includes a 7-day free trial. Nothing is charged during the trial."}
                  </Text>
                )}
                {status.hasActivePayment ? (
                  <Badge tone="success">
                    {isEs ? "Suscripción activa" : "Active subscription"}
                  </Badge>
                ) : (
                  <Badge tone="attention">
                    {isEs ? "Sin suscripción activa" : "No active subscription"}
                  </Badge>
                )}
                {status.isTestMode && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {isEs
                      ? "Modo de prueba: no se realizará ningún cargo real."
                      : "Test mode: no real charge will be made."}
                  </Text>
                )}
              </BlockStack>
              {actionData?.cancelled && (
                <Banner tone="success">
                  {isEs ? "Suscripción cancelada." : "Subscription cancelled."}
                </Banner>
              )}
              {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}
              {!status.hasActivePayment ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="subscribe" />
                  <Button submit variant="primary" loading={busy}>
                    {isEs ? "Suscribirme" : "Subscribe"}
                  </Button>
                </Form>
              ) : (
                <Form method="post">
                  <input type="hidden" name="intent" value="cancel" />
                  <Button submit tone="critical" loading={busy}>
                    {isEs ? "Cancelar suscripción" : "Cancel subscription"}
                  </Button>
                </Form>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
