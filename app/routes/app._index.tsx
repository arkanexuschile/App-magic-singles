import type { LoaderFunctionArgs } from "@remix-run/node";
import { Link, useLoaderData, useRevalidator, useSubmit } from "@remix-run/react";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  Badge,
  BlockStack,
  Card,
  Icon,
  InlineGrid,
  InlineStack,
  Layout,
  List,
  Page,
  Text,
  TextField,
  Button,
} from "@shopify/polaris";
import { useCallback, useRef, useState, useEffect } from "react";

// local SVG icons
function SearchSvg() { return <svg viewBox="0 0 20 20" fill="currentColor" width="20" height="20"><path d="M12.5 11h-.79l-.28-.27A6.471 6.471 0 0013 6.5 6.5 6.5 0 106.5 13a6.471 6.471 0 004.23-1.57l.27.28v.79l5 4.99L17.49 16l-4.99-5zm-6 0C4.01 11 2 8.99 2 6.5S4.01 2 6.5 2 11 4.01 11 6.5 8.99 11 6.5 11z"/></svg>; }
function ProductSvg() { return <svg viewBox="0 0 20 20" fill="currentColor" width="20" height="20"><path d="M10 2L2 6v8l8 4 8-4V6l-8-4zm0 2.32L14.13 7 10 9.68 5.87 7 10 4.32zM4 7.67l5.5 2.75v5.25L4 12.92V7.67zm6.5 8V10.42l5.5-2.75v5.25L10.5 15.67z"/></svg>; }
function InventorySvg() { return <svg viewBox="0 0 20 20" fill="currentColor" width="20" height="20"><path d="M17 3H3a1 1 0 00-1 1v2a1 1 0 001 1h14a1 1 0 001-1V4a1 1 0 00-1-1zm-1 5H4v7a1 1 0 001 1h10a1 1 0 001-1V8z"/></svg>; }
function CalendarSvg() { return <svg viewBox="0 0 20 20" fill="currentColor" width="20" height="20"><path d="M15 3h-1V2a1 1 0 10-2 0v1H8V2a1 1 0 10-2 0v1H5a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2V5a2 2 0 00-2-2zm0 12H5V7h10v8z"/></svg>; }
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
  const submit = useSubmit();
  const isEs = lang === "es";
  const withLang = (path: string) => `${path}?lang=${lang}`;
  const defaultScheduleLabel = formatScheduleLabel(syncInfo.defaultTimeUtc, isEs);
  const isCronRunning = syncInfo.currentScheduledStatus === "running";
  const [searchValue, setSearchValue] = useState("");
  const searchDebounce = useRef<ReturnType<typeof setTimeout>>();

  const handleSearchSubmit = useCallback(() => {
    if (!searchValue.trim()) return;
    const params = new URLSearchParams();
    params.set("search", searchValue.trim());
    params.set("lang", lang);
    submit(params, { action: "/app/singles", method: "get" });
  }, [searchValue, lang, submit]);

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchValue(value);
      if (searchDebounce.current) clearTimeout(searchDebounce.current);
      searchDebounce.current = setTimeout(() => {
        if (value.trim()) {
          const params = new URLSearchParams();
          params.set("search", value.trim());
          params.set("lang", lang);
          submit(params, { action: "/app/singles", method: "get" });
        }
      }, 600);
    },
    [lang, submit],
  );

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
      <TitleBar title="Magic Pricer Singles" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <Card padding="400">
              <InlineStack gap="300" align="start" blockAlign="center">
                <div style={{ flex: 1 }}>
                  <TextField
                    label={isEs ? "Buscar productos" : "Search products"}
                    labelHidden
                    placeholder={
                      isEs
                        ? "Buscar productos por título, SKU..."
                        : "Search products by title, SKU..."
                    }
                    prefix={<Icon source={SearchSvg} />}
                    value={searchValue}
                    onChange={handleSearchChange}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSearchSubmit();
                    }}
                    autoComplete="off"
                  />
                </div>
                <Button onClick={handleSearchSubmit}>
                  {isEs ? "Buscar" : "Search"}
                </Button>
                <Button url={withLang("/app/singles")} variant="plain">
                  {isEs ? "Catálogo completo" : "Full catalog"}
                </Button>
              </InlineStack>
            </Card>
          </Layout.Section>
        </Layout>

        <Layout>
          <Layout.Section>
            <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
              <Card padding="400">
                <InlineStack gap="200" blockAlign="center">
                  <Icon source={ProductSvg} tone="base" />
                  <BlockStack gap="050">
                    <Text as="p" variant="bodySm" tone="subdued">
                      {isEs ? "Productos" : "Products"}
                    </Text>
                    <Text as="h3" variant="headingXl">
                      {summary.productCount.toLocaleString()}
                      {summary.productCountCapped ? "+" : ""}
                    </Text>
                  </BlockStack>
                </InlineStack>
              </Card>
              <Card padding="400">
                <InlineStack gap="200" blockAlign="center">
                  <Icon source={InventorySvg} tone="base" />
                  <BlockStack gap="050">
                    <Text as="p" variant="bodySm" tone="subdued">
                      {isEs ? "Variantes" : "Variants"}
                    </Text>
                    <Text as="h3" variant="headingXl">
                      {summary.variantCount.toLocaleString()}
                      {summary.variantCountCapped ? "+" : ""}
                    </Text>
                  </BlockStack>
                </InlineStack>
              </Card>
              <Card padding="400">
                <InlineStack gap="200" blockAlign="center">
                  <Icon source={CalendarSvg} tone="base" />
                  <BlockStack gap="050">
                    <Text as="p" variant="bodySm" tone="subdued">
                      {isEs ? "Sincronización" : "Schedule"}
                    </Text>
                    <Text as="h3" variant="headingXl">
                      {defaultScheduleLabel}
                    </Text>
                  </BlockStack>
                </InlineStack>
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
