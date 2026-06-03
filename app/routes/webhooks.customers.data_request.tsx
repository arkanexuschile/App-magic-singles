import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  // This app stores no customer PII outside Shopify session/auth context.
  // If your implementation adds customer data storage, return or export data here.
  return new Response();
};
