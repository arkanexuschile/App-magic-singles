import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { BillingReplacementBehavior } from "@shopify/shopify-app-remix/server";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { authenticate, isBillingTestMode, isBillingEnabled } from "../shopify.server";
import type { BillingPlanInfo } from "../shopify.server";
import { getBillingStatus, isKnownPlan } from "../services/billing.server";
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
  const requestedPlan = String(formData.get("plan") || "");

  if (intent === "subscribe" || intent === "change") {
    if (!isKnownPlan(requestedPlan)) {
      return json({ ok: false, error: "Plan inválido" }, { status: 400 });
    }
    const status = await getBillingStatus(request);
    // Replacing an existing subscription requires a replacement behavior so
    // Shopify prorates the unused time and records the new charge instead of
    // asking the merchant to cancel first.
    await billing.request({
      plan: requestedPlan,
      isTest: isBillingTestMode(),
      ...(status.hasActivePayment
        ? { replacementBehavior: BillingReplacementBehavior.Standard }
        : {}),
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

function planTitle(plan: BillingPlanInfo, isEs: boolean): string {
  if (plan.interval === "annual") {
    return isEs ? "Plan anual" : "Annual plan";
  }
  return isEs ? "Plan mensual" : "Monthly plan";
}

function planIntervalLabel(plan: BillingPlanInfo, isEs: boolean): string {
  if (plan.interval === "annual") {
    return isEs ? "cada 12 meses" : "every 12 months";
  }
  return isEs ? "cada 30 días" : "every 30 days";
}

export default function BillingPage() {
  const { lang, status } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ ok?: boolean; cancelled?: boolean; error?: string }>();
  const navigation = useNavigation();
  const isEs = lang === "es";
  const busy = navigation.state === "submitting";
  const activePlan = status.plans.find((plan) => plan.key === status.activePlanKey) ?? null;

  return (
    <Page>
      <TitleBar title={isEs ? "Suscripción" : "Subscription"} />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center" align="space-between">
                  <Text as="h2" variant="headingMd">
                    {isEs ? "Plan actual" : "Current plan"}
                  </Text>
                  {status.hasActivePayment ? (
                    <Badge tone="success">
                      {isEs ? "Suscripción activa" : "Active subscription"}
                    </Badge>
                  ) : (
                    <Badge tone="attention">
                      {isEs ? "Sin suscripción activa" : "No active subscription"}
                    </Badge>
                  )}
                </InlineStack>
                {status.hasActivePayment && activePlan ? (
                  <Text as="p" variant="bodyMd">
                    <strong>{planTitle(activePlan, isEs)}</strong> —{" "}
                    {activePlan.currencyCode} {activePlan.amount}{" "}
                    {activePlan.interval === "annual"
                      ? isEs
                        ? "/ año"
                        : "/ year"
                      : isEs
                        ? "/ 30 días"
                        : "/ 30 days"}
                  </Text>
                ) : (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    {isEs
                      ? "Elige un plan para continuar. Todos incluyen 7 días de prueba gratis."
                      : "Pick a plan to continue. All plans include a 7-day free trial."}
                  </Text>
                )}
                {status.isTestMode && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {isEs
                      ? "Modo de prueba: no se realizará ningún cargo real."
                      : "Test mode: no real charge will be made."}
                  </Text>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  {isEs ? "Planes disponibles" : "Available plans"}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {isEs
                    ? "Puedes cambiar de plan cuando quieras. Shopify prorratea el saldo no usado y registra el cargo en Configuración → Plan y facturación del admin."
                    : "You can switch plans at any time. Shopify prorates unused time and records the charge under Settings → Plan and billing in the admin."}
                </Text>
                <BlockStack gap="300">
                  {status.plans.map((plan) => {
                    const isActive = status.activePlanKey === plan.key;
                    return (
                      <Card key={plan.key} padding="300">
                        <InlineStack gap="300" blockAlign="center" align="space-between" wrap>
                          <BlockStack gap="100">
                            <InlineStack gap="200" blockAlign="center">
                              <Text as="h3" variant="headingSm">
                                {planTitle(plan, isEs)}
                              </Text>
                              {isActive && (
                                <Badge tone="success">
                                  {isEs ? "Plan actual" : "Current plan"}
                                </Badge>
                              )}
                            </InlineStack>
                            <Text as="p" variant="bodyMd">
                              {plan.currencyCode} {plan.amount} {planIntervalLabel(plan, isEs)}
                              {" · "}
                              {isEs
                                ? `${plan.trialDays} días de prueba`
                                : `${plan.trialDays}-day trial`}
                            </Text>
                          </BlockStack>
                          {!isActive && (
                            <Form method="post">
                              <input
                                type="hidden"
                                name="intent"
                                value={status.hasActivePayment ? "change" : "subscribe"}
                              />
                              <input type="hidden" name="plan" value={plan.key} />
                              <Button submit variant="primary" loading={busy} disabled={busy}>
                                {status.hasActivePayment
                                  ? isEs
                                    ? "Cambiar a este plan"
                                    : "Switch to this plan"
                                  : isEs
                                    ? "Suscribirme"
                                    : "Subscribe"}
                              </Button>
                            </Form>
                          )}
                        </InlineStack>
                      </Card>
                    );
                  })}
                </BlockStack>
              </BlockStack>
            </Card>

            {actionData?.cancelled && (
              <Banner tone="success">
                {isEs ? "Suscripción cancelada." : "Subscription cancelled."}
              </Banner>
            )}
            {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}

            {status.hasActivePayment && (
              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    {isEs ? "Cancelar suscripción" : "Cancel subscription"}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {isEs
                      ? "Si cancelas, la app deja de sincronizar hasta que elijas un plan de nuevo."
                      : "If you cancel, the app stops syncing until you pick a plan again."}
                  </Text>
                  <Form method="post">
                    <input type="hidden" name="intent" value="cancel" />
                    <Button submit tone="critical" loading={busy} disabled={busy}>
                      {isEs ? "Cancelar suscripción" : "Cancel subscription"}
                    </Button>
                  </Form>
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
