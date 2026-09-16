import { redirect } from "@remix-run/node";
import { authenticate, MONTHLY_PLAN, isBillingTestMode, isBillingEnabled } from "../shopify.server";

export { MONTHLY_PLAN };

export type BillingStatus = {
  hasActivePayment: boolean;
  planName: string;
  amount: number;
  currencyCode: string;
  interval: string;
  isTestMode: boolean;
  subscriptionId: string | null;
};

/**
 * Requires an active subscription. If the shop has none, redirects to /app/billing.
 * Call at the top of protected route loaders (after authenticate.admin).
 * When billing is disabled (BILLING_ENABLED != true), this is a no-op.
 */
export async function requireActiveSubscription(request: Request): Promise<void> {
  if (!isBillingEnabled()) {
    return;
  }
  const { billing } = await authenticate.admin(request);
  await billing.require({
    plans: [MONTHLY_PLAN],
    isTest: isBillingTestMode(),
    onFailure: async () => {
      // Preserve the embedded auth query params (embedded, hmac, host,
      // id_token, shop, ...). Dropping them breaks embedded auth and loops
      // the request to /auth/login.
      const url = new URL(request.url);
      throw redirect(`/app/billing${url.search}`);
    },
  });
}

/**
 * Returns the current subscription status without redirecting.
 * Used by the billing page itself.
 */
export async function getBillingStatus(request: Request): Promise<BillingStatus> {
  const { billing } = await authenticate.admin(request);
  const { hasActivePayment, appSubscriptions } = await billing.check({
    plans: [MONTHLY_PLAN],
    isTest: isBillingTestMode(),
  });
  const sub = appSubscriptions?.[0];
  return {
    hasActivePayment,
    planName: MONTHLY_PLAN,
    amount: Number(process.env.BILLING_PLAN_PRICE ?? "19.99"),
    currencyCode: (process.env.BILLING_CURRENCY || "USD").toUpperCase(),
    interval: "Every 30 days",
    isTestMode: isBillingTestMode(),
    subscriptionId: sub?.id ?? null,
  };
}
