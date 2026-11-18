import { redirect } from "@remix-run/node";
import { BillingReplacementBehavior } from "@shopify/shopify-app-remix/server";
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

export type BillingPlanKey = typeof MONTHLY_PLAN | typeof ANNUAL_PLAN;

export const ACTIVE_PLANS: BillingPlanKey[] = [MONTHLY_PLAN, ANNUAL_PLAN];

/**
 * The Remix billing helpers are generic over the app config, but the inferred
 * type of `Config["billing"]` resolves to `never` for this configuration, so we
 * describe the slice of the API we use instead.
 */
type BillingApi = {
  require: (options: {
    plans: BillingPlanKey[];
    isTest?: boolean;
    onFailure: () => Promise<Response>;
  }) => Promise<unknown>;
  check: (options: {
    plans: BillingPlanKey[];
    isTest?: boolean;
  }) => Promise<{
    hasActivePayment: boolean;
    appSubscriptions?: Array<{ id: string; name?: string | null }>;
  }>;
  request: (options: {
    plan: BillingPlanKey;
    isTest?: boolean;
    replacementBehavior?: BillingReplacementBehavior;
  }) => Promise<never>;
  cancel: (options: {
    subscriptionId: string;
    isTest?: boolean;
    prorate?: boolean;
  }) => Promise<unknown>;
};

function asBillingApi(billing: unknown): BillingApi {
  return billing as unknown as BillingApi;
}

export type BillingStatus = {
  hasActivePayment: boolean;
  activePlanKey: BillingPlanKey | null;
  activePlanName: string | null;
  isTestMode: boolean;
  subscriptionId: string | null;
  plans: BillingPlanInfo[];
};

function planKeyForName(name: string | null | undefined): BillingPlanKey | null {
  if (name === MONTHLY_PLAN) {
    return MONTHLY_PLAN;
  }
  if (name === ANNUAL_PLAN) {
    return ANNUAL_PLAN;
  }
  return null;
}

export function isKnownPlan(plan: string | null | undefined): plan is BillingPlanKey {
  return plan === MONTHLY_PLAN || plan === ANNUAL_PLAN;
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
  await asBillingApi(billing).require({
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
  const { hasActivePayment, appSubscriptions } = await asBillingApi(billing).check({
    plans: ACTIVE_PLANS,
    isTest: isBillingTestMode(),
  });
  const subscription = appSubscriptions?.[0] ?? null;

  return {
    hasActivePayment,
    activePlanKey: planKeyForName(subscription?.name),
    activePlanName: subscription?.name ?? null,
    isTestMode: isBillingTestMode(),
    subscriptionId: subscription?.id ?? null,
    plans: getBillingPlans(),
  };
}

/**
 * Requests a plan (or a plan change). When the merchant already has an active
 * subscription, `replacementBehavior: STANDARD` makes Shopify prorate the
 * unused time and create the new charge instead of requiring a cancel first.
 */
export async function requestPlan(request: Request, plan: BillingPlanKey): Promise<never> {
  const { billing } = await authenticate.admin(request);
  const status = await getBillingStatus(request);
  return asBillingApi(billing).request({
    plan,
    isTest: isBillingTestMode(),
    ...(status.hasActivePayment
      ? { replacementBehavior: BillingReplacementBehavior.Standard }
      : {}),
  });
}

export async function cancelActiveSubscription(request: Request): Promise<boolean> {
  const { billing } = await authenticate.admin(request);
  const status = await getBillingStatus(request);
  if (!status.subscriptionId) {
    return false;
  }
  await asBillingApi(billing).cancel({
    subscriptionId: status.subscriptionId,
    isTest: isBillingTestMode(),
    prorate: true,
  });
  return true;
}
