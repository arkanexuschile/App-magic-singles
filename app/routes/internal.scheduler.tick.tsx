import { json, type ActionFunctionArgs } from "@remix-run/node";
import {
  getSchedulerDueCountPreview,
  getSchedulerNextDueSnapshot,
  triggerSchedulerTickInBackground,
} from "../services/sync-scheduler.server";

function getCronSecret(): string {
  return (process.env.CRON_SECRET ?? "").trim();
}

function unauthorized() {
  return json({ ok: false, message: "Unauthorized" }, { status: 401 });
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method.toUpperCase() !== "POST") {
    return json({ ok: false, message: "Method not allowed" }, { status: 405 });
  }

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

  const result = getSchedulerNextDueSnapshot();
  const dueCountPreviewPromise = getSchedulerDueCountPreview();
  const kickoff = triggerSchedulerTickInBackground({ trigger: "http" });
  const snapshot = await result;
  const dueCountPreview = await dueCountPreviewPromise;
  return json({
    ok: true,
    started: kickoff.started,
    dueCountPreview,
    ...snapshot,
    triggeredAtUtc: new Date().toISOString(),
  });
};

export const loader = async () => {
  return json({ ok: false, message: "Method not allowed" }, { status: 405 });
};
