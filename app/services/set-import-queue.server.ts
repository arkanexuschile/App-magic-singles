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
}): Promise<{ job: SetImportJobView; alreadyRunning: boolean }> {
  const setCode = params.setCode.toLowerCase();

  const active = await db.setImportJob.findFirst({
    where: { shop: params.shop, setCode, status: { in: ["queued", "running"] } },
    orderBy: { createdAt: "desc" },
  });
  if (active) {
    return { job: serializeJob(active), alreadyRunning: true };
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

async function runJobInBackground(params: {
  jobId: string;
  shop: string;
  accessToken: string;
  adminGraphql: (query: string, options?: Record<string, unknown>) => Promise<Response>;
  setCode: string;
  createAsActive: boolean;
}): Promise<void> {
  const { jobId, shop, accessToken, setCode, createAsActive } = params;

  console.log(`[SetImportQueue] starting import for set=${setCode} job=${jobId}`);

  const setInfo = await getScryfallSet(setCode);
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

  const workerPath = path.resolve(process.cwd(), "import-worker.cjs");
  const workerArgs = JSON.stringify({
    jobId,
    shop,
    accessToken,
    setCode,
    createAsActive,
    genericDescription: config.genericDescription || "",
  });

  const child = spawn(process.execPath, [workerPath, workerArgs], {
    stdio: "inherit",
    detached: true,
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL || "file:./prisma/dev.sqlite" },
  });
  child.unref();
}

void recoverStaleImportJobs();
