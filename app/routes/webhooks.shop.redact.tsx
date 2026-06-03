import type { ActionFunctionArgs } from "@remix-run/node";
import db from "../db.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  // Remove all session data for the shop after a redact request.
  await db.session.deleteMany({ where: { shop } });
  await db.syncConfiguration.deleteMany({ where: { shop } });

  return new Response();
};
