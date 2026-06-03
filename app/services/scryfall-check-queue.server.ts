import {
  type SyncPreferences,
  validateCustomScryfallIds,
  type CustomScryfallIdCheckResult,
} from "./price-sync.server";
import { writeSyncLog } from "./sync-log.server";

type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: {
      variables?: Record<string, unknown>;
    },
  ) => Promise<Response>;
  restGet?: (path: string) => Promise<Response>;
};

type ScryfallCheckStatusCode = "queued" | "running" | "success" | "failed";

export type ScryfallCheckStatus = {
  status: ScryfallCheckStatusCode;
  message: string | null;
  startedAtUtc: string | null;
  updatedAtUtc: string;
  completedAtUtc: string | null;
  result: CustomScryfallIdCheckResult | null;
};

type EnqueueScryfallCheckParams = {
  shop: string;
  admin: AdminGraphqlClient;
  preferences: SyncPreferences;
};

const STATUS_RETENTION_MS = 15 * 60 * 1000;
const LOG_PREFIX = "[scryfall-check-queue]";

declare global {
  // eslint-disable-next-line no-var
  var __scryfallCheckStatusByShop: Map<string, ScryfallCheckStatus> | undefined;
  // eslint-disable-next-line no-var
  var __scryfallCheckRunningByShop: Set<string> | undefined;
}

if (!global.__scryfallCheckStatusByShop) {
  global.__scryfallCheckStatusByShop = new Map<string, ScryfallCheckStatus>();
}
if (!global.__scryfallCheckRunningByShop) {
  global.__scryfallCheckRunningByShop = new Set<string>();
}

function nowIso() {
  return new Date().toISOString();
}

function logInfo(message: string, extra?: Record<string, unknown>) {
  if (extra) {
    console.log(`${LOG_PREFIX} ${message}`, extra);
    writeSyncLog("info", `${LOG_PREFIX} ${message}`, extra);
    return;
  }
  console.log(`${LOG_PREFIX} ${message}`);
  writeSyncLog("info", `${LOG_PREFIX} ${message}`);
}

function logError(message: string, extra?: Record<string, unknown>) {
  if (extra) {
    console.error(`${LOG_PREFIX} ${message}`, extra);
    writeSyncLog("error", `${LOG_PREFIX} ${message}`, extra);
    return;
  }
  console.error(`${LOG_PREFIX} ${message}`);
  writeSyncLog("error", `${LOG_PREFIX} ${message}`);
}

function setStatus(shop: string, status: ScryfallCheckStatusCode, payload?: {
  message?: string | null;
  startedAtUtc?: string | null;
  completedAtUtc?: string | null;
  result?: CustomScryfallIdCheckResult | null;
}) {
  global.__scryfallCheckStatusByShop?.set(shop, {
    status,
    message: payload?.message ?? null,
    startedAtUtc: payload?.startedAtUtc ?? null,
    updatedAtUtc: nowIso(),
    completedAtUtc: payload?.completedAtUtc ?? null,
    result: payload?.result ?? null,
  });
}

function isTerminal(status: ScryfallCheckStatusCode): boolean {
  return status === "success" || status === "failed";
}

export function getScryfallCheckStatusForShop(shop: string): ScryfallCheckStatus | null {
  const map = global.__scryfallCheckStatusByShop;
  if (!map) {
    return null;
  }

  const status = map.get(shop) ?? null;
  if (!status) {
    return null;
  }

  if (
    isTerminal(status.status) &&
    Date.now() - new Date(status.updatedAtUtc).getTime() > STATUS_RETENTION_MS
  ) {
    map.delete(shop);
    return null;
  }

  return status;
}

async function runScryfallCheckInBackground(params: EnqueueScryfallCheckParams) {
  const { shop, admin, preferences } = params;
  const startedAtUtc = nowIso();
  setStatus(shop, "running", { startedAtUtc });
  logInfo("runner started", { shop });

  try {
    const result = await validateCustomScryfallIds({
      admin,
      preferences,
    });
    setStatus(shop, "success", {
      startedAtUtc,
      completedAtUtc: nowIso(),
      result,
      message: null,
    });
    logInfo("runner completed", {
      shop,
      variantsScanned: result.variantsScanned,
      variantsWithCustomId: result.variantsWithCustomId,
      variantsFoundInScryfall: result.variantsFoundInScryfall,
      notFoundInScryfall: result.notFoundInScryfall,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(shop, "failed", {
      startedAtUtc,
      completedAtUtc: nowIso(),
      message,
    });
    logError("runner failed", { shop, message });
  } finally {
    global.__scryfallCheckRunningByShop?.delete(shop);
  }
}

export function enqueueScryfallCheckForShop(
  params: EnqueueScryfallCheckParams,
): { queued: boolean } {
  const runningSet = global.__scryfallCheckRunningByShop;
  if (!runningSet) {
    return { queued: false };
  }

  if (runningSet.has(params.shop)) {
    return { queued: false };
  }

  runningSet.add(params.shop);
  setStatus(params.shop, "queued", {
    startedAtUtc: null,
    completedAtUtc: null,
    message: null,
    result: null,
  });
  logInfo("runner queued", { shop: params.shop });

  void runScryfallCheckInBackground(params);
  return { queued: true };
}
