export type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
  restGet?: (path: string) => Promise<Response>;
};

const ADMIN_API_VERSION = "2025-01";
const SHOPIFY_GRAPHQL_TIMEOUT_MS = parseSafeMs(
  process.env.SHOPIFY_GRAPHQL_TIMEOUT_MS,
  30_000,
);
const SHOPIFY_GRAPHQL_MAX_RETRIES = (() => {
  const value = Number(process.env.SHOPIFY_GRAPHQL_MAX_RETRIES ?? "4");
  if (!Number.isFinite(value) || value < 0) {
    return 4;
  }
  return Math.min(8, Math.floor(value));
})();
const SHOPIFY_RETRY_BASE_DELAY_MS = parseSafeMs(
  process.env.SHOPIFY_RETRY_BASE_DELAY_MS,
  1000,
);
const SHOPIFY_RETRY_MAX_DELAY_MS = parseSafeMs(
  process.env.SHOPIFY_RETRY_MAX_DELAY_MS,
  60_000,
);

function parseSafeMs(rawValue: string | undefined, fallback: number): number {
  const value = Number(rawValue ?? fallback);
  if (!Number.isFinite(value) || value < 1000) {
    return fallback;
  }
  return Math.min(value, 5 * 60 * 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(SHOPIFY_RETRY_MAX_DELAY_MS, Math.ceil(seconds * 1000));
  }

  const parsedDate = Date.parse(value);
  if (!Number.isFinite(parsedDate)) {
    return null;
  }

  return Math.min(
    SHOPIFY_RETRY_MAX_DELAY_MS,
    Math.max(0, parsedDate - Date.now()),
  );
}

function getRetryDelayMs(params: {
  attempt: number;
  retryAfter?: string | null;
  throttled?: boolean;
}) {
  const retryAfterMs = parseRetryAfterMs(params.retryAfter ?? null);
  if (retryAfterMs !== null) {
    return retryAfterMs;
  }

  const multiplier = params.throttled ? 2 : 1;
  const exponential = SHOPIFY_RETRY_BASE_DELAY_MS * 2 ** params.attempt * multiplier;
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(SHOPIFY_RETRY_MAX_DELAY_MS, exponential + jitter);
}

function isSafeShopDomain(value: string): boolean {
  const domain = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain);
}

function getGraphqlOperationName(query: string): string {
  const namedOperation = /\b(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(query);
  return namedOperation?.[1] ?? "anonymous";
}

function parseShopifyApiError(raw: string): string | null {
  try {
    const payload = JSON.parse(raw) as unknown;
    if (payload && typeof payload === "object") {
      const root = payload as { error?: unknown; errors?: unknown };
      if (typeof root.error === "string" && root.error.trim()) {
        return root.error.trim();
      }
      if (Array.isArray(root.errors) && root.errors.length > 0) {
        const first = root.errors[0];
        if (typeof first === "string" && first.trim()) {
          return first.trim();
        }
        if (first && typeof first === "object" && "message" in first) {
          const message = (first as { message?: unknown }).message;
          if (typeof message === "string" && message.trim()) {
            return message.trim();
          }
        }
      }
      if (root.errors && typeof root.errors === "object" && "message" in root.errors) {
        const message = (root.errors as { message?: unknown }).message;
        if (typeof message === "string" && message.trim()) {
          return message.trim();
        }
      }
    }
  } catch {
    // Non-JSON error bodies are common for transport failures.
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, 300) : null;
}

async function readShopifyApiError(response: Response): Promise<string | null> {
  try {
    return parseShopifyApiError(await response.clone().text());
  } catch {
    return null;
  }
}

async function assertGraphqlJsonResponse(response: Response, operationName: string) {
  try {
    await response.clone().json();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const preview = await response.clone().text().catch(() => "");
    throw new Error(
      [
        "[API] Shopify GraphQL JSON response invalid",
        `operation=${operationName}`,
        `status=${response.status}`,
        `reason=${reason}`,
        `body=${preview.trim().slice(0, 300) || "empty"}`,
      ].join(" "),
    );
  }
}

function buildRequestFailureMessage(params: {
  protocol: "GraphQL" | "REST";
  operationName?: string;
  path?: string;
  status?: number;
  statusText?: string;
  reason: string;
  attempt: number;
  timeoutMs: number;
  requestId?: string | null;
  retryAfter?: string | null;
}) {
  return [
    `[API] Shopify ${params.protocol} request failed`,
    params.operationName ? `operation=${params.operationName}` : null,
    params.path ? `path=${params.path}` : null,
    params.status ? `status=${params.status}` : null,
    params.statusText ? `statusText=${params.statusText}` : null,
    `reason=${params.reason}`,
    `attempt=${params.attempt}/${SHOPIFY_GRAPHQL_MAX_RETRIES + 1}`,
    `timeoutMs=${params.timeoutMs}`,
    params.requestId ? `requestId=${params.requestId}` : null,
    params.retryAfter ? `retryAfter=${params.retryAfter}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

export function createShopAdminClient(
  shop: string,
  accessToken: string,
): AdminGraphqlClient {
  if (!isSafeShopDomain(shop)) {
    throw new Error("Invalid shop domain");
  }

  return {
    graphql: async (query, options) => {
      const operationName = getGraphqlOperationName(query);
      for (let attempt = 0; attempt <= SHOPIFY_GRAPHQL_MAX_RETRIES; attempt += 1) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), SHOPIFY_GRAPHQL_TIMEOUT_MS);
        try {
          const response = await fetch(
            `https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": accessToken,
              },
              body: JSON.stringify({
                query,
                variables: options?.variables ?? {},
              }),
              signal: controller.signal,
            },
          );

          const isRetryableStatus = response.status === 429 || response.status >= 500;
          if (isRetryableStatus && attempt < SHOPIFY_GRAPHQL_MAX_RETRIES) {
            await sleep(getRetryDelayMs({
              attempt,
              retryAfter: response.headers.get("retry-after"),
              throttled: response.status === 429,
            }));
            continue;
          }
          if (!response.ok) {
            const apiMessage = await readShopifyApiError(response);
            throw new Error(buildRequestFailureMessage({
              protocol: "GraphQL",
              operationName,
              status: response.status,
              statusText: response.statusText,
              reason: apiMessage ?? `HTTP ${response.status}`,
              attempt: attempt + 1,
              timeoutMs: SHOPIFY_GRAPHQL_TIMEOUT_MS,
              requestId: response.headers.get("x-request-id"),
              retryAfter: response.headers.get("retry-after"),
            }));
          }

          await assertGraphqlJsonResponse(response, operationName);
          return response;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const isAbort = error instanceof Error && error.name === "AbortError";
          const isRetryableNetwork =
            isAbort || /(UND_ERR|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|timeout)/i.test(message);
          if (isRetryableNetwork && attempt < SHOPIFY_GRAPHQL_MAX_RETRIES) {
            await sleep(getRetryDelayMs({ attempt }));
            continue;
          }
          if (message.startsWith("[API] Shopify")) {
            throw error;
          }
          throw new Error(buildRequestFailureMessage({
            protocol: "GraphQL",
            operationName,
            reason: isAbort ? "request aborted by timeout" : message,
            attempt: attempt + 1,
            timeoutMs: SHOPIFY_GRAPHQL_TIMEOUT_MS,
          }));
        } finally {
          clearTimeout(timeoutId);
        }
      }

      throw new Error(buildRequestFailureMessage({
        protocol: "GraphQL",
        operationName,
        reason: "request failed after retries",
        attempt: SHOPIFY_GRAPHQL_MAX_RETRIES + 1,
        timeoutMs: SHOPIFY_GRAPHQL_TIMEOUT_MS,
      }));
    },
    restGet: async (path) => {
      const normalizedPath = path.startsWith("/") ? path : `/${path}`;
      for (let attempt = 0; attempt <= SHOPIFY_GRAPHQL_MAX_RETRIES; attempt += 1) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), SHOPIFY_GRAPHQL_TIMEOUT_MS);
        try {
          const response = await fetch(
            `https://${shop}/admin/api/${ADMIN_API_VERSION}${normalizedPath}`,
            {
              method: "GET",
              headers: {
                Accept: "application/json",
                "X-Shopify-Access-Token": accessToken,
              },
              signal: controller.signal,
            },
          );

          const isRetryableStatus = response.status === 429 || response.status >= 500;
          if (isRetryableStatus && attempt < SHOPIFY_GRAPHQL_MAX_RETRIES) {
            await sleep(getRetryDelayMs({
              attempt,
              retryAfter: response.headers.get("retry-after"),
              throttled: response.status === 429,
            }));
            continue;
          }
          if (!response.ok) {
            const apiMessage = await readShopifyApiError(response);
            throw new Error(buildRequestFailureMessage({
              protocol: "REST",
              path: normalizedPath,
              status: response.status,
              statusText: response.statusText,
              reason: apiMessage ?? `HTTP ${response.status}`,
              attempt: attempt + 1,
              timeoutMs: SHOPIFY_GRAPHQL_TIMEOUT_MS,
              requestId: response.headers.get("x-request-id"),
              retryAfter: response.headers.get("retry-after"),
            }));
          }

          return response;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const isAbort = error instanceof Error && error.name === "AbortError";
          const isRetryableNetwork =
            isAbort || /(UND_ERR|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|timeout)/i.test(message);
          if (isRetryableNetwork && attempt < SHOPIFY_GRAPHQL_MAX_RETRIES) {
            await sleep(getRetryDelayMs({ attempt }));
            continue;
          }
          if (message.startsWith("[API] Shopify")) {
            throw error;
          }
          throw new Error(buildRequestFailureMessage({
            protocol: "REST",
            path: normalizedPath,
            reason: isAbort ? "request aborted by timeout" : message,
            attempt: attempt + 1,
            timeoutMs: SHOPIFY_GRAPHQL_TIMEOUT_MS,
          }));
        } finally {
          clearTimeout(timeoutId);
        }
      }

      throw new Error(buildRequestFailureMessage({
        protocol: "REST",
        path: normalizedPath,
        reason: "request failed after retries",
        attempt: SHOPIFY_GRAPHQL_MAX_RETRIES + 1,
        timeoutMs: SHOPIFY_GRAPHQL_TIMEOUT_MS,
      }));
    },
  };
}
