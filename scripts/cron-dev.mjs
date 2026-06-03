import fs from "node:fs";
import path from "node:path";

function loadDotEnvIfPresent() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const idx = line.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    process.env[key] = value;
  }
}

loadDotEnvIfPresent();

const baseUrl = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const cronSecret = (process.env.CRON_SECRET ?? "").trim();
const tickIntervalSeconds = Number(process.env.CRON_TICK_SECONDS ?? "60");
const tickIntervalMs =
  Number.isFinite(tickIntervalSeconds) && tickIntervalSeconds >= 5
    ? Math.floor(tickIntervalSeconds * 1000)
    : 60_000;
const requestTimeoutMsRaw = Number(process.env.CRON_DEV_REQUEST_TIMEOUT_MS ?? "300000");
const requestTimeoutMs =
  Number.isFinite(requestTimeoutMsRaw) && requestTimeoutMsRaw >= 10_000
    ? Math.floor(requestTimeoutMsRaw)
    : 300_000;
const verbose = process.env.CRON_DEV_VERBOSE === "1";
let tickCount = 0;
let tickInFlight = false;

if (!cronSecret) {
  console.error("[cron-dev] Missing CRON_SECRET environment variable.");
  process.exit(1);
}

const endpoint = `${baseUrl}/internal/scheduler/tick`;

async function runTick() {
  if (tickInFlight) {
    if (verbose) {
      console.log("[cron-dev] skipped tick: previous request still running", { tick: tickCount });
    }
    return null;
  }

  tickCount += 1;
  tickInFlight = true;
  const startedAt = new Date();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, requestTimeoutMs);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "x-cron-secret": cronSecret,
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const payload = await response.json().catch(() => ({}));
    const durationMs = Date.now() - startedAt.getTime();
    if (!response.ok) {
      console.error("[cron-dev] tick failed", {
        tick: tickCount,
        status: response.status,
        payload,
        durationMs,
      });
      return;
    }
    const started = Boolean(payload?.started);
    const dueCountPreview = Number(payload?.dueCountPreview ?? 0);
    if (started && dueCountPreview > 0) {
      console.log("[cron-dev][EXECUTION]", {
        tick: tickCount,
        started,
        dueCountPreview,
        nextDueShop: payload?.nextDueShop ?? null,
        nextDueAtUtc: payload?.nextDueAtUtc ?? null,
        secondsUntilNextDue: payload?.secondsUntilNextDue ?? null,
        triggeredAtUtc: payload?.triggeredAtUtc ?? startedAt.toISOString(),
        durationMs,
      });
      return null;
    }

    if (verbose) {
      console.log("[cron-dev] tick skipped (already running)", {
        tick: tickCount,
        started,
        dueCountPreview,
        durationMs,
      });
    }
    return payload;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const cause =
      error && typeof error === "object" && "cause" in error
        ? error.cause
        : undefined;
    console.error("[cron-dev] tick error", {
      tick: tickCount,
      endpoint,
      message: errorMessage,
      cause:
        cause && typeof cause === "object"
          ? {
              name: cause.name,
              message: cause.message,
              code: cause.code,
              errno: cause.errno,
              address: cause.address,
              port: cause.port,
            }
          : cause,
    });
    return null;
  } finally {
    tickInFlight = false;
  }
}

console.log("[cron-dev] started", {
  endpoint,
  intervalSeconds: Math.floor(tickIntervalMs / 1000),
  requestTimeoutMs,
  verbose,
});

const firstTickPayload = await runTick();
if (firstTickPayload?.nextDueAtUtc) {
  console.log("[cron-dev] next scheduled execution", {
    shop: firstTickPayload.nextDueShop ?? null,
    nextDueAtUtc: firstTickPayload.nextDueAtUtc,
    secondsUntilNextDue: firstTickPayload.secondsUntilNextDue ?? null,
  });
} else {
  console.log("[cron-dev] no scheduled execution found (no enabled shops or no nextRunAt).");
}
setInterval(() => {
  void runTick();
}, tickIntervalMs);
