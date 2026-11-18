import { redirect } from "@remix-run/node";
import {
  authenticate,
  ANNUAL_PLAN,
  MONTHLY_PLAN,
  getBillingPlans,
  isBillingTestMode,
  isBillingEnabled,
} from "../shopify.server";
import type { BillingPlanInfo } from "../shopify.server";

export { MONTHLY_PLAN, ANNUAL_PLAN, getBillingPlans };
export type { BillingPlanInfo };

export const ACTIVE_PLANS: Array<typeof MONTHLY_PLAN | typeof ANNUAL_PLAN> = [
  MONTHLY_PLAN,
  ANNUAL_PLAN,
];

export type BillingStatus = {
  hasActivePayment: boolean;
  activePlanKey: string | null;
  activePlanName: string | null;
  amount: number;
  currencyCode: string;
  interval: "every_30_days" | "annual" | null;
  isTestMode: boolean;
  subscriptionId: string | null;
  plans: BillingPlanInfo[];
};

function planKeyForName(name: string | null | undefined): string | null {
  if (!name) {
    return null;
  }
  if (name === MONTHLY_PLAN) {
    return MONTHLY_PLAN;
  }
  if (name === ANNUAL_PLAN) {
    return ANNUAL_PLAN;
  }
  return null;
}

/**
 * Requires an active subscription on any of the offered plans. If the shop has
 * none, redirects to /app/billing so the merchant can pick a plan.
 * When billing is disabled (BILLING_ENABLED != true), this is a no-op.
 */
export async function requireActiveSubscription(request: Request): Promise<void> {
  if (!isBillingEnabled()) {
    return;
  }
  const { billing } = await authenticate.admin(request);
  await billing.require({
    plans: ACTIVE_PLANS,
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
 * Returns the current subscription status, the active plan and every plan the
 * merchant can switch to. Used by the billing page itself.
 */
export async function getBillingStatus(request: Request): Promise<BillingStatus> {
  const { billing } = await authenticate.admin(request);
  const { hasActivePayment, appSubscriptions } = await billing.check({
    plans: ACTIVE_PLANS,
    isTest: isBillingTestMode(),
  });
  const plans = getBillingPlans();
  const subscription = appSubscriptions?.[0] ?? null;
  const activePlanKey = planKeyForName(subscription?.name);
  const activePlan = plans.find((plan) => plan.key === activePlanKey) ?? null;

  return {
    hasActivePayment,
    activePlanKey,
    activePlanName: subscription?.name ?? null,
    amount: activePlan?.amount ?? plans[0].amount,
    currencyCode: activePlan?.currencyCode ?? plans[0].currencyCode,
    interval: activePlan?.interval ?? null,
    isTestMode: isBillingTestMode(),
    subscriptionId: subscription?.id ?? null,
    plans,
  };
}

export function isKnownPlan(
  plan: string | null | undefined,
): plan is typeof MONTHLY_PLAN | typeof ANNUAL_PLAN {
  return plan === MONTHLY_PLAN || plan === ANNUAL_PLAN;
}
