import type { SetImportJob } from "@prisma/client";
import { spawn } from "child_process";
import path from "path";
import db from "../db.server";
import {
  getScryfallSet,
} from "./set-importer.server";
import { ensureProductMetafieldDefinitions } from "./metafield-definitions.server";
import { createShopAdminClient } from "./shopify/admin-client.server";
import { getOrCreateSyncConfiguration } from "./sync-config.server";
import type { SetImportProgress } from "./set-importer.server";

const ERROR_CAP = 50;

export async function recoverStaleImportJobs(): Promise<number> {
  const result = await db.setImportJob.updateMany({
    where: { status: { in: ["queued", "running"] } },
    data: {
      status: "failed",
      message: "El proceso de dev se reinició; la importación quedó interrumpida. Vuelve a importar el set.",
      finishedAt: new Date(),
    },
  });
  if (result.count > 0) {
    console.log(`[SetImportQueue] recovered ${result.count} stale import job(s)`);
  }
  return result.count;
}

export type SetImportJobView = {
  id: string;
  setCode: string;
  status: string;
  createAsActive: boolean;
  total: number;
  processed: number;
  created: number;
  failed: number;
  skipped: number;
  errorCount: number;
  errors: Array<{ card: string; error: string }>;
  message: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

function serializeJob(row: SetImportJob): SetImportJobView {
  let errors: Array<{ card: string; error: string }> = [];
  if (row.errors) {
    try {
      errors = JSON.parse(row.errors) as Array<{ card: string; error: string }>;
    } catch {
      errors = [];
    }
  }
  return {
    id: row.id,
    setCode: row.setCode,
    status: row.status,
    createAsActive: row.createAsActive,
    total: row.total,
    processed: row.processed,
    created: row.created,
    failed: row.failed,
    skipped: row.skipped,
    errorCount: row.errorCount,
    errors,
    message: row.message,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function enqueueSetImport(params: {
  shop: string;
  accessToken: string;
  adminGraphql: (query: string, options?: Record<string, unknown>) => Promise<Response>;
  setCode: string;
  createAsActive: boolean;
  lang?: string;
}): Promise<{ job: SetImportJobView; alreadyRunning: boolean }> {
  const setCode = params.setCode.toLowerCase();

  const active = await db.setImportJob.findFirst({
    where: { shop: params.shop, setCode, status: { in: ["queued", "running"] } },
    orderBy: { createdAt: "desc" },
  });
  if (active) {
    // If the queued job is stale (>5 min), mark it as failed and start fresh
    const ageMs = Date.now() - active.createdAt.getTime();
    if (active.status === "queued" && ageMs > 5 * 60 * 1000) {
      await db.setImportJob.update({
        where: { id: active.id },
        data: { status: "failed", message: "Importación atascada (reinicio automático)", finishedAt: new Date() },
      });
    } else {
      return { job: serializeJob(active), alreadyRunning: true };
    }
  }

  const row = await db.setImportJob.create({
    data: {
      shop: params.shop,
      setCode,
      status: "queued",
      createAsActive: params.createAsActive,
    },
  });

  void runJobInBackground({ jobId: row.id, ...params });

  return { job: serializeJob(row), alreadyRunning: false };
}

export async function listSetImportJobs(shop: string): Promise<SetImportJobView[]> {
  const rows = await db.setImportJob.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return rows.map(serializeJob);
}

export async function getSetImportJob(id: string, shop: string): Promise<SetImportJobView | null> {
  const row = await db.setImportJob.findFirst({ where: { id, shop } });
  return row ? serializeJob(row) : null;
}

export async function cancelSetImportJob(id: string, shop: string): Promise<boolean> {
  const row = await db.setImportJob.findFirst({ where: { id, shop, status: { in: ["queued", "running"] } } });
  if (!row) return false;
  await db.setImportJob.update({
    where: { id },
    data: { status: "cancelled", message: "Cancelado por el usuario", finishedAt: new Date() },
  });
  console.log(`[SetImportQueue] cancelled job ${id}`);
  return true;
}

async function runJobInBackground(params: {
  jobId: string;
  shop: string;
  accessToken: string;
  adminGraphql: (query: string, options?: Record<string, unknown>) => Promise<Response>;
  setCode: string;
  createAsActive: boolean;
  lang?: string;
}): Promise<void> {
  const { jobId, shop, accessToken, setCode, createAsActive, lang } = params;

  console.log(`[SetImportQueue] starting import for set=${setCode} job=${jobId}`);
  await db.setImportJob.update({ where: { id: jobId }, data: { status: "running", startedAt: new Date() } }).catch(() => {});

  let setInfo;
  try {
    setInfo = await getScryfallSet(setCode);
  } catch (e) {
    await db.setImportJob.update({
      where: { id: jobId },
      data: { status: "failed", message: `Scryfall API error: ${e instanceof Error ? e.message : String(e)}`, finishedAt: new Date() },
    });
    return;
  }
  if (!setInfo) {
    await db.setImportJob.update({
      where: { id: jobId },
      data: { status: "failed", message: `Set "${setCode}" not found`, finishedAt: new Date() },
    });
    return;
  }

  try {
    await ensureProductMetafieldDefinitions(createShopAdminClient(shop, accessToken).graphql);
  } catch (error) {
    await db.setImportJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        message: `No se pudieron crear las definiciones de metafields: ${error instanceof Error ? error.message : String(error)}`,
        finishedAt: new Date(),
      },
    });
    return;
  }

  const config = await getOrCreateSyncConfiguration(shop);

  const workerPath = "/var/www/shopify-price-singles/import-worker.cjs";
  const workerArgs = JSON.stringify({
    jobId,
    shop,
    accessToken,
    setCode,
    createAsActive,
    lang: lang || "en",
    genericDescription: config.genericDescription || "",
  });

  console.log(`[SetImportQueue] spawning worker: ${workerPath} job=${jobId}`);
  const child = spawn(process.execPath, [workerPath, workerArgs], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: "file:/var/www/shopify-price-singles/prisma/dev.sqlite" },
  });
  child.on("error", (err) => console.error(`[SetImportQueue] spawn error: ${err.message}`));
  child.unref();
}

void recoverStaleImportJobs();
