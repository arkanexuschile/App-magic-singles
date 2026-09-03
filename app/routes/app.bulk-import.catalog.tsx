import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { listScryfallSets } from "../services/set-importer.server";
import { fetchAllCards, buildCatalogBuffer } from "../services/bulk-import.server";

function decodeSetCodes(encoded: string): string[] {
  return encoded.split(",").map((s) => s.trim()).filter(Boolean);
}

function decodeLangs(encoded: string): string[] {
  if (!encoded) return [];
  return encoded.split(",").map((s) => s.trim()).filter(Boolean);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);

  let setCodes: string[];
  const all = url.searchParams.get("all") === "true";
  if (all) {
    const allSets = await listScryfallSets();
    setCodes = allSets.map((s) => s.code);
  } else {
    const raw = url.searchParams.get("setCodes") || "";
    setCodes = decodeSetCodes(raw);
  }
  const langs = decodeLangs(url.searchParams.get("langs") || "");

  if (setCodes.length === 0) {
    return new Response("No set codes selected", { status: 400 });
  }

  // Safety cap for the "all editions" download: generating hundreds of MB
  // on demand can time out. Limit to the first 200 sets.
  if (all && setCodes.length > 200) {
    setCodes = setCodes.slice(0, 200);
  }

  const cards = [];
  const skippedSets: string[] = [];
  for (const code of setCodes) {
    try {
      const setCards = await fetchAllCards(code, langs);
      cards.push(...setCards);
    } catch (e) {
      // Tolerate a single set failing (e.g. Scryfall throttling) instead of
      // dropping the whole export. Log and continue with the rest.
      console.error(`catalog: skipped set ${code}: ${e instanceof Error ? e.message : String(e)}`);
      skippedSets.push(code);
    }
  }

  const buffer = buildCatalogBuffer(cards);
  const fileSuffix = new Date().toISOString().slice(0, 10);
  const fileName = all ? `catalogo-todas-ediciones-${fileSuffix}.xlsx` : `catalogo-singles-${fileSuffix}.xlsx`;

  const headers: Record<string, string> = {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Cache-Control": "no-store",
  };
  if (skippedSets.length > 0) {
    headers["X-Catalog-Skipped-Sets"] = skippedSets.join(",");
  }

  return new Response(new Uint8Array(buffer), { status: 200, headers });
};
