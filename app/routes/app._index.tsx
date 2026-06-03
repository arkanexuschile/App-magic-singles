import type { LoaderFunctionArgs } from "@remix-run/node";
import { Link, useLoaderData, useRevalidator } from "@remix-run/react";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  Badge,
  BlockStack,
  Card,
  InlineGrid,
  Layout,
  List,
  Page,
  Text,
} from "@shopify/polaris";
import { useEffect } from "react";
import {
  computeNextRunAt,
  getOrCreateSyncConfiguration,
} from "../services/sync-config.server";
import { recoverStaleRunningStateForShop } from "../services/sync-scheduler.server";
import { listRecentSyncRunsForShop } from "../services/sync-run-history.server";
import { authenticate } from "../shopify.server";
import { detectLanguage } from "../utils/i18n";

type RecentProduct = {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  sampleVariantSku: string | null;
  sampleVariantPrice: string | null;
};

type ConnectionPage = {
  edges: Array<{ cursor: string }>;
  pageInfo: { hasNextPage: boolean };
};

type DashboardSummary = {
  productCount: number;
  variantCount: number;
  productCountCapped: boolean;
  variantCountCapped: boolean;
};

type RecentSyncRun = {
  id: string;
  startedAt: Date;
  variantsScanned: number | null;
  cardsMatched: number | null;
  pricesUpdated: number | null;
  failuresCount: number | null;
  suspiciousCount: number | null;
};

function formatUtcDateTime(date: Date, lang: "es" | "en"): string {
  return new Intl.DateTimeFormat(lang === "es" ? "es-CL" : "en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(date);
}

function getGraphqlErrorMessages(rawErrors: unknown): string[] {
  if (!Array.isArray(rawErrors)) {
    return [];
  }

  return rawErrors
    .map((item) => {
      if (item && typeof item === "object" && "message" in item) {
        const message = (item as { message?: unknown }).message;
        if (typeof message === "string" && message.trim().length > 0) {
          return message;
        }
      }
      return null;
    })
    .filter((message): message is string => Boolean(message));
}

function formatScheduleLabel(rawValue: string, isEs: boolean): string {
  const minuteToken = rawValue.trim();
  if (minuteToken === "every_30m") {
    return isEs ? "Cada 30 minutos" : "Every 30 minutes";
  }
  if (minuteToken === "every_10m" || minuteToken === "every_5m") {
    // Legacy minute presets are normalized to 30 minutes.
    return isEs ? "Cada 30 minutos" : "Every 30 minutes";
  }

  const hourlyMatch = /^every_(1[0-2]|[1-9])h$/.exec(rawValue.trim());
  if (hourlyMatch) {
    const hours = Number(hourlyMatch[1]);
    return isEs
      ? `Cada ${hours} hora${hours === 1 ? "" : "s"}`
      : `Every ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return rawValue;
}

async function fetchConnectionCount(params: {
  adminGraphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
  query: string;
  rootField: "products" | "productVariants";
  maxRecords: number;
}) {
  const { adminGraphql, query, rootField, maxRecords } = params;
  const pageSize = 250;
  let cursor: string | null = null;
  let hasNextPage = true;
  let count = 0;
  let capped = false;

  while (hasNextPage && count < maxRecords) {
    const response = await adminGraphql(query, {
      variables: {
        first: pageSize,
        after: cursor,
      },
    });
    const json = (await response.json()) as {
      errors?: Array<{ message: string }>;
      data?: Record<string, ConnectionPage>;
    };

    const graphqlErrors = getGraphqlErrorMessages(json.errors);
    if (graphqlErrors.length > 0) {
      throw new Error(graphqlErrors.join("; "));
    }

    const connection = json.data?.[rootField];
    if (!connection) {
      return { count: 0, capped: false };
    }

    count += connection.edges.length;
    hasNextPage = connection.pageInfo.hasNextPage;
    cursor =
      connection.edges.length > 0
        ? connection.edges[connection.edges.length - 1].cursor
        : null;
  }

  if (hasNextPage) {
    capped = true;
  }

  return { count, capped };
}

async function loadDashboardSummary(
  adminGraphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>,
): Promise<DashboardSummary> {
  const [products, variants] = await Promise.all([
    fetchConnectionCount({
      adminGraphql,
      rootField: "products",
      maxRecords: 5000,
      query: `#graphql
        query CountProducts($first: Int!, $after: String) {
          products(first: $first, after: $after) {
            edges {
              cursor
            }
            pageInfo {
              hasNextPage
            }
          }
        }
      `,
    }),
    fetchConnectionCount({
      adminGraphql,
      rootField: "productVariants",
      maxRecords: 5000,
      query: `#graphql
        query CountVariants($first: Int!, $after: String) {
          productVariants(first: $first, after: $after) {
            edges {
              cursor
            }
            pageInfo {
              hasNextPage
            }
          }
        }
      `,
    }),
  ]);

  return {
    productCount: products.count,
    variantCount: variants.count,
    productCountCapped: products.capped,
    variantCountCapped: variants.capped,
  };
}

async function loadRecentProducts(
  adminGraphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>,
): Promise<RecentProduct[]> {
  const response = await adminGraphql(
    `#graphql
      query DashboardRecentProducts {
        products(first: 8, sortKey: UPDATED_AT, reverse: true) {
          edges {
            node {
              id
              title
              status
              updatedAt
              variants(first: 1) {
                edges {
                  node {
                    sku
                    price
                  }
                }
              }
            }
          }
        }
      }
    `,
  );

  const json = (await response.json()) as {
    errors?: Array<{ message: string }>;
    data?: {
      products?: {
        edges: Array<{
          node: {
            id: string;
            title: string;
            status: string;
            updatedAt: string;
            variants: {
              edges: Array<{
                node: { sku: string | null; price: string | null };
              }>;
            };
          };
        }>;
      };
    };
  };

  const graphqlErrors = getGraphqlErrorMessages(json.errors);
  if (graphqlErrors.length > 0) {
    throw new Error(graphqlErrors.join("; "));
  }

  return (json.data?.products?.edges ?? []).map((edge) => {
    const variant = edge.node.variants.edges[0]?.node;
    return {
      id: edge.node.id,
      title: edge.node.title,
      status: edge.node.status,
      updatedAt: edge.node.updatedAt,
      sampleVariantSku: variant?.sku ?? null,
      sampleVariantPrice: variant?.price ?? null,
    };
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const lang = detectLanguage(request);
  await recoverStaleRunningStateForShop(session.shop);
  const syncConfig = await getOrCreateSyncConfiguration(session.shop);
  const now = new Date();
  const nextRunAtDisplay =
    syncConfig.enabled && (!syncConfig.nextRunAt || syncConfig.nextRunAt <= now)
      ? computeNextRunAt(syncConfig.dailyTime, syncConfig.timezone, now)
      : syncConfig.nextRunAt;

  let summary: DashboardSummary = {
    productCount: 0,
    variantCount: 0,
    productCountCapped: false,
    variantCountCapped: false,
  };
  let recentProducts: RecentProduct[] = [];
  let recentSyncRuns: RecentSyncRun[] = [];
  let dashboardError: string | null = null;

  try {
    [summary, recentProducts, recentSyncRuns] = await Promise.all([
      loadDashboardSummary(admin.graphql),
      loadRecentProducts(admin.graphql),
      listRecentSyncRunsForShop(session.shop, 5),
    ]);
  } catch (error) {
    dashboardError =
      error instanceof Error ? error.message : "Dashboard data unavailable";
  }

  return {
    lang,
    summary,
    recentProducts,
    recentSyncRuns,
    dashboardError,
    syncInfo: {
      enabled: syncConfig.enabled,
      defaultTimeUtc: syncConfig.dailyTime || "03:00",
      nextRunAt: nextRunAtDisplay,
      lastRunAt: syncConfig.lastRunAt,
      lastRunStatus: syncConfig.lastRunStatus,
      currentScheduledStatus: syncConfig.currentScheduledStatus,
      currentScheduledProcessedVariants: syncConfig.currentScheduledProcessedVariants,
      currentScheduledTotalVariants: syncConfig.currentScheduledTotalVariants,
      currentScheduledProcessedBlocks: syncConfig.currentScheduledProcessedBlocks,
      currentScheduledTotalBlocks: syncConfig.currentScheduledTotalBlocks,
      currentScheduledRemainingBlocks: syncConfig.currentScheduledRemainingBlocks,
      currentScheduledUpdatedAt: syncConfig.currentScheduledUpdatedAt,
    },
  };
};

export default function HomePage() {
  const { lang, summary, recentProducts, recentSyncRuns, dashboardError, syncInfo } =
    useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const isEs = lang === "es";
  const withLang = (path: string) => `${path}?lang=${lang}`;
  const defaultScheduleLabel = formatScheduleLabel(syncInfo.defaultTimeUtc, isEs);
  const isCronRunning = syncInfo.currentScheduledStatus === "running";

  useEffect(() => {
    if (!isCronRunning) {
      return;
    }
    const intervalId = setInterval(() => {
      revalidator.revalidate();
    }, 10_000);
    return () => clearInterval(intervalId);
  }, [isCronRunning, revalidator]);

  return (
    <Page>
      <TitleBar title="Magic Pricer" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  {isEs
                    ? "Dashboard de Catálogo y Sincronización"
                    : "Catalog & Sync Dashboard"}
                </Text>
                <Text as="p" variant="bodyMd">
                  {isEs
                    ? "Vista rápida del estado actual de productos, últimas actualizaciones y configuración de sincronización."
                    : "Quick view of current product status, latest updates, and sync configuration."}
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        <Layout>
          <Layout.Section>
            <InlineGrid columns={3} gap="300">
              <Card>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">
                    {isEs ? "Productos actuales" : "Current products"}
                  </Text>
                  <Text as="h3" variant="headingLg">
                    {summary.productCount}
                    {summary.productCountCapped ? "+" : ""}
                  </Text>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">
                    {isEs ? "Variantes actuales" : "Current variants"}
                  </Text>
                  <Text as="h3" variant="headingLg">
                    {summary.variantCount}
                    {summary.variantCountCapped ? "+" : ""}
                  </Text>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">
                    {isEs ? "Horario por defecto (UTC)" : "Default schedule (UTC)"}
                  </Text>
                  <Text as="h3" variant="headingLg">
                    {defaultScheduleLabel}
                  </Text>
                </BlockStack>
              </Card>
            </InlineGrid>
          </Layout.Section>
        </Layout>

        <Layout>
          <Layout.Section>
            <BlockStack gap="300">
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingMd">
                    {isEs ? "Últimos productos actualizados" : "Latest updated products"}
                  </Text>
                  {dashboardError ? (
                    <Text as="p" variant="bodyMd" tone="critical">
                      {isEs
                        ? `No se pudieron cargar estadísticas: ${dashboardError}`
                        : `Could not load dashboard statistics: ${dashboardError}`}
                    </Text>
                  ) : recentProducts.length === 0 ? (
                    <Text as="p" variant="bodyMd">
                      {isEs
                        ? "No hay productos recientes para mostrar."
                        : "No recent products to display."}
                    </Text>
                  ) : (
                    <List>
                      {recentProducts.map((product) => (
                        <List.Item key={product.id}>
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            {product.title}
                          </Text>{" "}
                          <Badge tone="info">{product.status}</Badge>{" "}
                          <Text as="span" variant="bodySm" tone="subdued">
                            {isEs ? "Actualizado:" : "Updated:"}{" "}
                            {formatUtcDateTime(new Date(product.updatedAt), lang)}
                          </Text>{" "}
                          {product.sampleVariantSku ? (
                            <Text as="span" variant="bodySm">
                              SKU: {product.sampleVariantSku} |{" "}
                              {isEs ? "Precio:" : "Price:"}{" "}
                              {product.sampleVariantPrice ?? "-"}
                            </Text>
                          ) : null}
                        </List.Item>
                      ))}
                    </List>
                  )}
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <BlockStack gap="300">
              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">
                    {isEs ? "Estado de sincronización" : "Sync status"}
                  </Text>
                  <List>
                    <List.Item>
                      {isEs ? "Programación activa:" : "Schedule enabled:"}{" "}
                      {syncInfo.enabled ? (isEs ? "Sí" : "Yes") : isEs ? "No" : "No"}
                    </List.Item>
                    <List.Item>
                      {isEs ? "Próxima ejecución:" : "Next run:"}{" "}
                      {syncInfo.nextRunAt
                        ? formatUtcDateTime(new Date(syncInfo.nextRunAt), lang)
                        : isEs
                          ? "No programada"
                          : "Not scheduled"}
                    </List.Item>
                    <List.Item>
                      {isEs ? "Última ejecución:" : "Last run:"}{" "}
                      {syncInfo.lastRunAt
                        ? formatUtcDateTime(new Date(syncInfo.lastRunAt), lang)
                        : isEs
                          ? "Nunca"
                          : "Never"}
                    </List.Item>
                    <List.Item>
                      {isEs ? "Último estado:" : "Last status:"}{" "}
                      {syncInfo.lastRunStatus ?? (isEs ? "N/A" : "N/A")}
                    </List.Item>
                    <List.Item>
                      {isEs ? "Cron ejecutándose ahora:" : "Cron running now:"}{" "}
                      {syncInfo.currentScheduledStatus === "running"
                        ? isEs
                          ? "Sí"
                          : "Yes"
                        : isEs
                          ? "No"
                          : "No"}
                    </List.Item>
                  </List>
                  <Text as="p" variant="bodySm">
                    <Link to={withLang("/app/price-sync")}>
                      {isEs
                        ? "Ir al panel de sincronización"
                        : "Go to sync configuration panel"}
                    </Link>
                  </Text>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  {isEs ? "Historial de sincronizaciones" : "Synchronization history"}
                </Text>
                {recentSyncRuns.length === 0 ? (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    {isEs ? "Aún no hay información de corridas." : "No run information is available yet."}
                  </Text>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>
                            {isEs ? "Fecha y hora (UTC)" : "Date and time (UTC)"}
                          </th>
                          <th style={{ textAlign: "right", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>
                            {isEs ? "Escaneados" : "Scanned"}
                          </th>
                          <th style={{ textAlign: "right", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>
                            {isEs ? "Encontradas" : "Found"}
                          </th>
                          <th style={{ textAlign: "right", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>
                            {isEs ? "Actualizadas" : "Updated"}
                          </th>
                          <th style={{ textAlign: "right", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>
                            {isEs ? "Fallos" : "Failures"}
                          </th>
                          <th style={{ textAlign: "right", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>
                            {isEs ? "Sospechas" : "Suspicious"}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {recentSyncRuns.map((run) => (
                          <tr key={run.id}>
                            <td style={{ padding: "8px", borderBottom: "1px solid #f1f3f5" }}>
                              {formatUtcDateTime(new Date(run.startedAt), lang)}
                            </td>
                            <td style={{ padding: "8px", borderBottom: "1px solid #f1f3f5", textAlign: "right" }}>
                              {run.variantsScanned ?? "-"}
                            </td>
                            <td style={{ padding: "8px", borderBottom: "1px solid #f1f3f5", textAlign: "right" }}>
                              {run.cardsMatched ?? "-"}
                            </td>
                            <td style={{ padding: "8px", borderBottom: "1px solid #f1f3f5", textAlign: "right" }}>
                              {run.pricesUpdated ?? "-"}
                            </td>
                            <td style={{ padding: "8px", borderBottom: "1px solid #f1f3f5", textAlign: "right" }}>
                              {run.failuresCount ?? "-"}
                            </td>
                            <td style={{ padding: "8px", borderBottom: "1px solid #f1f3f5", textAlign: "right" }}>
                              {run.suspiciousCount ?? "-"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
