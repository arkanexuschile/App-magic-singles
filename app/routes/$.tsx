import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";

function unauthorizedPayload(pathname: string) {
  return {
    ok: false,
    message: "Unauthorized",
    path: pathname,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const pathname = new URL(request.url).pathname;
  return json(unauthorizedPayload(pathname), { status: 401 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const pathname = new URL(request.url).pathname;
  return json(unauthorizedPayload(pathname), { status: 401 });
};

export default function UnauthorizedCatchAllRoute() {
  return null;
}

