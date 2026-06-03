import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import path from "node:path";
import { writeSyncLog } from "../services/sync-log.server";

function getCronSecret(): string {
  return (process.env.CRON_SECRET ?? "").trim();
}

function unauthorized() {
  return json({ ok: false, message: "Unauthorized" }, { status: 401 });
}

function resolveLogFilePath(): string {
  const configured = process.env.PRICE_SYNC_LOG_FILE?.trim();
  if (configured) {
    return path.resolve(process.cwd(), configured);
  }
  return path.resolve(process.cwd(), "logs/price-sync.log");
}

function validateSecret(request: Request) {
  const secret = getCronSecret();
  if (!secret) {
    return json(
      { ok: false, message: "CRON_SECRET is not configured" },
      { status: 500 },
    );
  }

  const providedSecret = request.headers.get("x-cron-secret")?.trim() ?? "";
  if (providedSecret !== secret) {
    return unauthorized();
  }

  return null;
}

function buildDiagnostics() {
  const marker = `logging-health:${Date.now()}`;
  writeSyncLog("info", "[internal-logging-health] probe", { marker });

  return {
    ok: true,
    marker,
    cwd: process.cwd(),
    pid: process.pid,
    pm2ProcessName: process.env.name ?? null,
    pm2Id: process.env.pm_id ?? null,
    nodeEnv: process.env.NODE_ENV ?? null,
    fileLoggingEnabled: process.env.PRICE_SYNC_FILE_LOG === "1",
    configuredLogFile: process.env.PRICE_SYNC_LOG_FILE ?? null,
    resolvedLogFile: resolveLogFilePath(),
    perVariantLoggingEnabled: process.env.PRICE_SYNC_LOG_PER_VARIANT === "1",
    generatedAtUtc: new Date().toISOString(),
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const authError = validateSecret(request);
  if (authError) {
    return authError;
  }
  return json(buildDiagnostics());
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const authError = validateSecret(request);
  if (authError) {
    return authError;
  }
  return json(buildDiagnostics());
};
