import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

function isFileLogEnabled(): boolean {
  return process.env.PRICE_SYNC_FILE_LOG === "1";
}

function resolveLogFilePath(): string {
  const configured = process.env.PRICE_SYNC_LOG_FILE?.trim();
  if (configured) {
    return path.resolve(process.cwd(), configured);
  }
  return path.resolve(process.cwd(), "logs/price-sync.log");
}

export function writeSyncLog(
  level: "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
): void {
  if (!isFileLogEnabled()) {
    return;
  }

  const filePath = resolveLogFilePath();
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...extra,
  };

  void mkdir(path.dirname(filePath), { recursive: true })
    .then(() => appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8"))
    .catch(() => {
      // Never break sync execution because of file logging errors.
    });
}

