import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getSetImportJob } from "../services/set-import-queue.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const jobId = url.searchParams.get("job")?.trim() ?? "";
  const job = jobId ? await getSetImportJob(jobId, session.shop) : null;
  const items = job?.existingItems ?? [];

  const header = "set_code,scryfall_id,nombre,acabado,sku,stock_solicitado";
  const rows = items.map((it) => {
    const esc = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    return [
      job?.setCode ?? "",
      it.scryfallId,
      esc(it.name),
      it.foil ? "foil" : "no-foil",
      esc(it.sku),
      it.stock,
    ].join(",");
  });
  const csv = [header, ...rows].join("\n");
  const fileSuffix = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ya-existentes-${fileSuffix}.csv"`,
      "Cache-Control": "no-store",
    },
  });
};
