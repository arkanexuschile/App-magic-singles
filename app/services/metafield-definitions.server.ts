export type AdminGraphql = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

export type MetafieldDefinitionSpec = {
  namespace: string;
  key: string;
  name: string;
  type: string;
  description?: string;
};

export const PRODUCT_METAFIELD_DEFINITIONS: MetafieldDefinitionSpec[] = [
  { namespace: "custom", key: "scryfall_id", name: "Scryfall ID", type: "single_line_text_field" },
  { namespace: "custom", key: "oracle_id", name: "Oracle ID", type: "single_line_text_field" },
  { namespace: "custom", key: "set_code", name: "Código de set", type: "single_line_text_field" },
  { namespace: "custom", key: "collector_number", name: "Nº de colección", type: "single_line_text_field" },
  { namespace: "custom", key: "foil", name: "Es foil", type: "boolean", description: "Indica si el producto es la variante foil de la carta." },
  { namespace: "custom", key: "artist", name: "Artista", type: "single_line_text_field" },
  { namespace: "custom", key: "cmc", name: "Coste de maná convertible", type: "number_decimal" },
  { namespace: "custom", key: "colors", name: "Colores", type: "single_line_text_field" },
  { namespace: "custom", key: "rarity", name: "Rareza", type: "single_line_text_field" },
  { namespace: "custom", key: "card_types", name: "Tipos de carta", type: "single_line_text_field" },
  { namespace: "custom", key: "formats", name: "Formatos legales", type: "single_line_text_field" },
  { namespace: "custom", key: "language", name: "Idioma", type: "single_line_text_field" },
  { namespace: "custom", key: "power", name: "Fuerza", type: "single_line_text_field" },
  { namespace: "custom", key: "toughness", name: "Resistencia", type: "single_line_text_field" },
  { namespace: "custom", key: "keywords", name: "Palabras clave", type: "single_line_text_field" },
  { namespace: "custom", key: "released_at", name: "Fecha de lanzamiento", type: "date" },
];

const EXISTING_DEFINITIONS_QUERY = `#graphql
  query ExistingProductMetafieldDefinitions($cursor: String) {
    metafieldDefinitions(first: 250, ownerType: PRODUCT, after: $cursor) {
      nodes {
        id
        namespace
        key
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const CREATE_DEFINITION_MUTATION = `#graphql
  mutation CreateProductMetafieldDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
        namespace
        key
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function toDefinitionInput(spec: MetafieldDefinitionSpec): Record<string, unknown> {
  const input: Record<string, unknown> = {
    namespace: spec.namespace,
    key: spec.key,
    name: spec.name,
    type: spec.type,
    ownerType: "PRODUCT",
  };
  if (spec.description) {
    input.description = spec.description;
  }
  return input;
}

/**
 * Ensures every product metafield definition used by the app exists in the shop.
 * Idempotent: queries existing definitions and only creates the missing ones.
 */
export async function ensureProductMetafieldDefinitions(
  adminGraphql: AdminGraphql,
): Promise<{ created: number; existing: number }> {
  const existingKeys = new Set<string>();
  let cursor: string | null = null;

  do {
    const response = await adminGraphql(EXISTING_DEFINITIONS_QUERY, {
      variables: { cursor },
    });
    const json = (await response.json()) as {
      data?: {
        metafieldDefinitions?: {
          nodes: Array<{ id: string; namespace: string; key: string }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
      errors?: unknown;
    };
    if (json.errors) {
      throw new Error(
        `[MetafieldDefinitions] query failed: ${JSON.stringify(json.errors).slice(0, 300)}`,
      );
    }
    const page = json.data?.metafieldDefinitions;
    if (!page) {
      break;
    }
    for (const node of page.nodes) {
      existingKeys.add(`${node.namespace}.${node.key}`);
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  let created = 0;
  for (const spec of PRODUCT_METAFIELD_DEFINITIONS) {
    if (existingKeys.has(`${spec.namespace}.${spec.key}`)) {
      continue;
    }
    const response = await adminGraphql(CREATE_DEFINITION_MUTATION, {
      variables: { definition: toDefinitionInput(spec) },
    });
    const json = (await response.json()) as {
      data?: {
        metafieldDefinitionCreate?: {
          userErrors: Array<{ field: string; message: string }>;
        };
      };
      errors?: unknown;
    };
    if (json.errors) {
      const message = Array.isArray(json.errors)
        ? json.errors.map((e) => (e && typeof e === "object" && "message" in e ? String(e.message) : JSON.stringify(e))).join("; ")
        : JSON.stringify(json.errors);
      throw new Error(`[MetafieldDefinitions] failed to create ${spec.namespace}.${spec.key}: ${message}`);
    }
    const errors = json.data?.metafieldDefinitionCreate?.userErrors ?? [];
    if (errors.length > 0) {
      const message = errors.map((e) => `${e.field ?? "?"}: ${e.message}`).join("; ");
      throw new Error(`[MetafieldDefinitions] failed to create ${spec.namespace}.${spec.key}: ${message}`);
    }
    created += 1;
  }

  return { created, existing: existingKeys.size };
}
