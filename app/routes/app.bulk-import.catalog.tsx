import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { fetchAllCards, buildCatalogBuffer } from "../services/bulk-import.server";

function decodeSetCodes(encoded: string): string[] {
  return encoded.split(",").map((s) => s.trim()).filter(Boolean);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const raw = url.searchParams.get("setCodes") || "";
  const setCodes = decodeSetCodes(raw);
  if (setCodes.length === 0) {
    return new Response("No set codes selected", { status: 400 });
  }

  const cards = [];
  for (const code of setCodes) {
    const setCards = await fetchAllCards(code);
    cards.push(...setCards);
  }

  const buffer = buildCatalogBuffer(cards);
  const fileSuffix = new Date().toISOString().slice(0, 10);

  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="catalogo-singles-${fileSuffix}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
};
