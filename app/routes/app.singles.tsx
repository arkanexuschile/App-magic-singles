import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams, useSubmit } from "@remix-run/react";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  BlockStack,
  Card,
  Grid,
  Icon,
  Page,
  Text,
  TextField,
  Select,
  Button,
  Badge,
  InlineStack,
  SkeletonBodyText,
  SkeletonDisplayText,
} from "@shopify/polaris";
import { useCallback, useEffect, useRef, useState } from "react";

function SearchSvg() { return <svg viewBox="0 0 20 20" fill="currentColor" width="20" height="20"><path d="M12.5 11h-.79l-.28-.27A6.471 6.471 0 0013 6.5 6.5 6.5 0 106.5 13a6.471 6.471 0 004.23-1.57l.27.28v.79l5 4.99L17.49 16l-4.99-5zm-6 0C4.01 11 2 8.99 2 6.5S4.01 2 6.5 2 11 4.01 11 6.5 8.99 11 6.5 11z"/></svg>; }
import { authenticate } from "../shopify.server";
import { detectLanguage } from "../utils/i18n";

type ProductNode = {
  id: string;
  title: string;
  status: string;
  description: string;
  featuredImage?: { url: string; altText?: string } | null;
  totalInventory: number;
  variants: {
    edges: Array<{
      node: {
        id: string;
        sku: string | null;
        price: string;
        displayName: string;
        inventoryQuantity: number | null;
      };
    }>;
  };
};

type PageInfo = {
  hasNextPage: boolean;
  endCursor: string | null;
};

type LoaderData = {
  products: ProductNode[];
  pageInfo: PageInfo;
  searchQuery: string;
  statusFilter: string;
  lang: "es" | "en";
};

const PRODUCTS_QUERY = `#graphql
  query SinglesCatalog($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
      edges {
        node {
          id
          title
          status
          description
          featuredImage {
            url
            altText
          }
          totalInventory
          variants(first: 5) {
            edges {
              node {
                id
                sku
                price
                displayName
                inventoryQuantity
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const lang = detectLanguage(request);
  const url = new URL(request.url);
  const searchQuery = url.searchParams.get("search") || "";
  const statusFilter = url.searchParams.get("status") || "";
  const cursor = url.searchParams.get("cursor") || null;

  let graphqlQuery = searchQuery;
  if (statusFilter) {
    const statusMap: Record<string, string> = {
      active: "status:active",
      draft: "status:draft",
      archived: "status:archived",
    };
    const statusTerm = statusMap[statusFilter];
    graphqlQuery = graphqlQuery
      ? `${graphqlQuery} AND ${statusTerm}`
      : statusTerm;
  }

  const response = await admin.graphql(PRODUCTS_QUERY, {
    variables: {
      first: 12,
      after: cursor,
      query: graphqlQuery || undefined,
    },
  });

  const json_response = (await response.json()) as {
    errors?: Array<{ message: string }>;
    data?: {
      products: {
        edges: Array<{ node: ProductNode }>;
        pageInfo: PageInfo;
      };
    };
  };

  const products = json_response.data?.products?.edges?.map((e) => e.node) ?? [];
  const pageInfo = json_response.data?.products?.pageInfo ?? {
    hasNextPage: false,
    endCursor: null,
  };

  return json({ products, pageInfo, searchQuery, statusFilter, lang });
};

export default function SinglesCatalog() {
  const { products, pageInfo, searchQuery, statusFilter, lang } =
    useLoaderData<typeof loader>();
  const isEs = lang === "es";
  const [search, setSearch] = useState(searchQuery);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const submit = useSubmit();
  const [searchParams] = useSearchParams();

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearch(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const params = new URLSearchParams(searchParams);
        if (value) params.set("search", value);
        else params.delete("search");
        params.delete("cursor");
        submit(params);
      }, 400);
    },
    [searchParams, submit],
  );

  const handleStatusChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams);
      if (value) params.set("status", value);
      else params.delete("status");
      params.delete("cursor");
      submit(params);
    },
    [searchParams, submit],
  );

  const handleLoadMore = useCallback(() => {
    if (!pageInfo.endCursor) return;
    const params = new URLSearchParams(searchParams);
    params.set("cursor", pageInfo.endCursor);
    submit(params);
  }, [pageInfo.endCursor, searchParams, submit]);

  return (
    <Page
      title={isEs ? "Catálogo de Singles" : "Singles Catalog"}
      subtitle={
        isEs
          ? "Busca y explora tus productos de cartas individuales"
          : "Search and browse your individual card products"
      }
    >
      <TitleBar title={isEs ? "Catálogo de Singles" : "Singles Catalog"} />
      <BlockStack gap="400">
        <Card>
          <InlineStack gap="300" align="start" blockAlign="end">
            <div style={{ flex: 1 }}>
              <TextField
                label={isEs ? "Buscar productos" : "Search products"}
                labelHidden
                placeholder={
                  isEs
                    ? "Buscar por título, SKU..."
                    : "Search by title, SKU..."
                }
                prefix={<Icon source={SearchSvg} />}
                value={search}
                onChange={handleSearchChange}
                autoComplete="off"
              />
            </div>
            <div style={{ minWidth: 180 }}>
              <Select
                label={isEs ? "Estado" : "Status"}
                labelHidden
                options={[
                  {
                    label: isEs ? "Todos los estados" : "All statuses",
                    value: "",
                  },
                  { label: isEs ? "Activo" : "Active", value: "active" },
                  { label: isEs ? "Borrador" : "Draft", value: "draft" },
                  { label: isEs ? "Archivado" : "Archived", value: "archived" },
                ]}
                value={statusFilter}
                onChange={handleStatusChange}
              />
            </div>
          </InlineStack>
        </Card>

        {products.length === 0 ? (
          <Card>
            <BlockStack gap="200" align="center">
              <Text as="p" variant="bodyMd" tone="subdued">
                {isEs
                  ? "No se encontraron productos con esos filtros."
                  : "No products found with those filters."}
              </Text>
            </BlockStack>
          </Card>
        ) : (
          <Grid columns={{ xs: 1, sm: 2, md: 3, lg: 4 }} gap="300">
            {products.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                isEs={isEs}
              />
            ))}
          </Grid>
        )}

        {pageInfo.hasNextPage && (
          <InlineStack align="center">
            <Button onClick={handleLoadMore} variant="secondary">
              {isEs ? "Cargar más productos" : "Load more products"}
            </Button>
          </InlineStack>
        )}
      </BlockStack>
    </Page>
  );
}

function statusBadge(status: string, isEs: boolean) {
  const statusLower = status.toLowerCase();
  if (statusLower === "active") {
    return <Badge tone="success">{isEs ? "Activo" : "Active"}</Badge>;
  }
  if (statusLower === "draft") {
    return <Badge>{isEs ? "Borrador" : "Draft"}</Badge>;
  }
  if (statusLower === "archived") {
    return <Badge tone="critical">{isEs ? "Archivado" : "Archived"}</Badge>;
  }
  return <Badge>{status}</Badge>;
}

function ProductCard({
  product,
  isEs,
}: {
  product: ProductNode;
  isEs: boolean;
}) {
  const [imgError, setImgError] = useState(false);
  const imageUrl = product.featuredImage?.url;
  const firstVariant = product.variants.edges[0]?.node;
  const variantCount = product.variants.edges.length;

  return (
    <Card padding="300">
      <BlockStack gap="200">
        <div
          style={{
            width: "100%",
            aspectRatio: "1",
            background: "#f6f6f7",
            borderRadius: "8px",
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {imageUrl && !imgError ? (
            <img
              src={imageUrl}
              alt={product.featuredImage?.altText || product.title}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
              }}
              onError={() => setImgError(true)}
            />
          ) : (
            <Icon source={SearchSvg} />
          )}
        </div>

        <BlockStack gap="100">
          <Text as="h3" variant="headingSm" truncate>
            {product.title}
          </Text>
          {statusBadge(product.status, isEs)}
        </BlockStack>

        {firstVariant && (
          <BlockStack gap="050">
            {firstVariant.sku && (
              <Text as="p" variant="bodySm" tone="subdued">
                SKU: {firstVariant.sku}
              </Text>
            )}
            <InlineStack gap="100" align="space-between" blockAlign="center">
              <Text as="p" variant="headingMd" fontWeight="bold">
                ${parseFloat(firstVariant.price).toFixed(2)}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {isEs ? "Stock:" : "Stock:"} {product.totalInventory}
              </Text>
            </InlineStack>
          </BlockStack>
        )}

        {variantCount > 1 && (
          <Text as="p" variant="bodySm" tone="subdued">
            {isEs
              ? `+${variantCount - 1} variante${variantCount - 1 > 1 ? "s" : ""} más`
              : `+${variantCount - 1} more variant${variantCount - 1 > 1 ? "s" : ""}`}
          </Text>
        )}
      </BlockStack>
    </Card>
  );
}
