import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { startPriceSyncScheduler } from "./services/sync-scheduler.server";
import { ensureProductMetafieldDefinitions } from "./services/metafield-definitions.server";
import { createShopAdminClient } from "./services/shopify/admin-client.server";

export const MONTHLY_PLAN = "Monthly subscription";

function billingPlanAmount(): number {
  const raw = Number(process.env.BILLING_PLAN_PRICE ?? "19.99");
  return Number.isFinite(raw) && raw > 0 ? raw : 19.99;
}

function billingCurrency(): string {
  const raw = (process.env.BILLING_CURRENCY || "USD").trim().toUpperCase();
  return raw || "USD";
}

export function isBillingTestMode(): boolean {
  if ((process.env.BILLING_TEST_MODE || "").trim().toLowerCase() === "false") {
    return false;
  }
  return true;
}

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.April26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || process.env.HOST || `https://${process.env.APP_URL?.replace(/^https?:\/\//, "") || "localhost"}`,
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  billing: {
    [MONTHLY_PLAN]: {
      trialDays: 7,
      lineItems: [
        {
          amount: billingPlanAmount(),
          currencyCode: billingCurrency(),
          interval: BillingInterval.Every30Days,
        },
      ],
    },
  },
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
  hooks: {
    afterAuth: async ({ session }) => {
      try {
        const adminGraphql = createShopAdminClient(session.shop, session.accessToken ?? "");
        const result = await ensureProductMetafieldDefinitions(adminGraphql.graphql);
        console.log(
          `[afterAuth] shop=${session.shop} metafield definitions created=${result.created} existing=${result.existing}`,
        );
      } catch (error) {
        console.error(
          `[afterAuth] failed to create metafield definitions for ${session.shop}`,
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  },
});

export default shopify;
export const apiVersion = ApiVersion.April26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;

startPriceSyncScheduler();
