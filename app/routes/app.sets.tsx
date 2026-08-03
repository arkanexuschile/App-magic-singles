import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Form,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  BlockStack,
  Card,
  Icon,
  Page,
  Text,
  TextField,
  Button,
  InlineStack,
  Badge,
  Banner,
  Scrollable,
  Select,
  ProgressBar,
} from "@shopify/polaris";
import { useCallback, useEffect, useRef, useState } from "react";
import { authenticate } from "../shopify.server";
import { detectLanguage } from "../utils/i18n";
import {
  listScryfallSets,
  searchScryfallSets,
  getScryfallSet,
  getSetCards,
} from "../services/set-importer.server";
import type { ScryfallSetInfo, ScryfallCardInfo } from "../services/set-importer.server";
import {
  enqueueSetImport,
  listSetImportJobs,
  getSetImportJob,
} from "../services/set-import-queue.server";
import type { SetImportJobView } from "../services/set-import-queue.server";

function SearchSvg() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" width="20" height="20">
      <path d="M12.5 11h-.79l-.28-.27A6.471 6.471 0 0013 6.5 6.5 6.5 0 106.5 13a6.471 6.471 0 004.23-1.57l.27.28v.79l5 4.99L17.49 16l-4.99-5zm-6 0C4.01 11 2 8.99 2 6.5S4.01 2 6.5 2 11 4.01 11 6.5 8.99 11 6.5 11z" />
    </svg>
  );
}

function LoaderSvg() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" width="20" height="20">
      <path d="M10 2a1 1 0 011 1v2a1 1 0 11-2 0V3a1 1 0 011-1zm0 12a1 1 0 011 1v2a1 1 0 11-2 0v-2a1 1 0 011-1zM3 9a1 1 0 100 2h2a1 1 0 100-2H3zm12 0a1 1 0 100 2h2a1 1 0 100-2h-2zm-8.485 2.243a1 1 0 00-1.414 1.414l1.414 1.414a1 1 0 001.414-1.414l-1.414-1.414zm8.485-8.486a1 1 0 00-1.414-1.414l-1.414 1.414a1 1 0 001.414 1.414l1.414-1.414zM5.757 4.929a1 1 0 00-1.414 1.414l1.414 1.414a1 1 0 101.414-1.414L5.757 4.929zm8.486 8.486a1 1 0 00-1.414-1.414l-1.414 1.414a1 1 0 101.414 1.414l-1.414-1.414z" />
    </svg>
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const lang = detectLanguage(request);
  const url = new URL(request.url);
  const searchQuery = url.searchParams.get("q") || "";
  const setCode = url.searchParams.get("set") || "";
  const jobId = url.searchParams.get("job") || "";

  let recentSets: ScryfallSetInfo[] = [];
  let selectedSet: ScryfallSetInfo | null = null;
  let setCards: ScryfallCardInfo[] = [];

  if (setCode) {
    selectedSet = await getScryfallSet(setCode);
    if (selectedSet) {
      setCards = await getSetCards(selectedSet.code);
    }
  }

  if (searchQuery) {
    recentSets = await searchScryfallSets(searchQuery);
  } else if (!setCode) {
    recentSets = (await listScryfallSets()).slice(0, 30);
  }

  const jobs = await listSetImportJobs(session.shop);
  const currentJob = jobId ? await getSetImportJob(jobId, session.shop) : null;

  return json({
    lang,
    recentSets,
    setCards,
    selectedSet,
    searchQuery,
    jobs,
    currentJob,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const setCode = formData.get("setCode") as string;
  const createAsActive = formData.get("createAsActive") === "true";

  const setInfo = await getScryfallSet(setCode);
  if (!setInfo) {
    return json({ error: `Set "${setCode}" not found` }, { status: 404 });
  }

  const accessToken = session.accessToken;
  if (!accessToken) {
    return json({ error: "Missing shop access token" }, { status: 401 });
  }

  const { job, alreadyRunning } = await enqueueSetImport({
    setCode,
    createAsActive,
    adminGraphql: admin.graphql,
    shop: session.shop,
    accessToken,
  });

  return json({ job, alreadyRunning, setCode });
};

function formatPrice(price: number | null): string {
  if (price === null) return "-";
  return `$${price.toFixed(2)}`;
}

function rarityBadge(rarity: string) {
  const r = rarity.toLowerCase();
  if (r === "mythic") return <Badge tone="critical">Mythic</Badge>;
  if (r === "rare") return <Badge tone="warning">Rare</Badge>;
  if (r === "uncommon") return <Badge tone="info">Uncommon</Badge>;
  return <Badge>Common</Badge>;
}

function jobStatusBadge(job: SetImportJobView) {
  if (job.status === "running") return <Badge tone="attention">Running</Badge>;
  if (job.status === "queued") return <Badge>Queued</Badge>;
  if (job.status === "completed") return <Badge tone="success">Completed</Badge>;
  if (job.status === "failed") return <Badge tone="critical">Failed</Badge>;
  return <Badge>{job.status}</Badge>;
}

function jobProgress(job: SetImportJobView): number {
  if (job.total <= 0) return 0;
  return Math.round((job.processed / job.total) * 100);
}

export default function SetsPage() {
  const { lang, recentSets, setCards, selectedSet, searchQuery, jobs, currentJob } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<{
    job?: SetImportJobView;
    alreadyRunning?: boolean;
    error?: string;
    setCode?: string;
  }>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const fetcher = useFetcher<typeof loader>();
  const isEs = lang === "es";
  const [search, setSearch] = useState(searchQuery);
  const [activeJobId, setActiveJobId] = useState<string | null>(currentJob?.id ?? null);
  const [createAsActive, setCreateAsActive] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const isSubmitting =
    navigation.state === "submitting" && navigation.formData?.get("intent") === "import";

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearch(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const params = new URLSearchParams();
        if (value) params.set("q", value);
        params.set("lang", lang);
        submit(params, { method: "get" });
      }, 400);
    },
    [lang, submit],
  );

  const handleSelectSet = useCallback(
    (code: string) => {
      const params = new URLSearchParams();
      params.set("set", code);
      params.set("lang", lang);
      submit(params, { method: "get" });
    },
    [lang, submit],
  );

  useEffect(() => {
    if (actionData?.job) {
      setActiveJobId(actionData.job.id);
    }
  }, [actionData]);

  const activeJob =
    (activeJobId ? fetcher.data?.currentJob ?? actionData?.job : null) ??
    (activeJobId ? currentJob : null) ??
    null;

  const isActive = activeJob?.status === "queued" || activeJob?.status === "running";

  useEffect(() => {
    if (!activeJobId || !isActive) return;
    const load = () => {
      if (fetcher.state === "loading") return;
      fetcher.load(`/app/sets?job=${activeJobId}&lang=${lang}`);
    };
    const interval = setInterval(load, 2000);
    return () => clearInterval(interval);
  }, [activeJobId, isActive, lang, fetcher]);

  const handleSelectJob = useCallback(
    (jobId: string) => {
      setActiveJobId(jobId);
      fetcher.load(`/app/sets?job=${jobId}&lang=${lang}`);
    },
    [lang, fetcher],
  );

  const progress = activeJob ? jobProgress(activeJob) : 0;

  return (
    <Page
      title={isEs ? "Importar Sets de Magic" : "Import Magic Sets"}
      subtitle={
        isEs
          ? "Busca un set de Magic y crea productos en Shopify"
          : "Search for a Magic set and create products in Shopify"
      }
    >
      <TitleBar title={isEs ? "Importar Sets de Magic" : "Import Magic Sets"} />
      <BlockStack gap="400">
        <Card>
          <TextField
            label={isEs ? "Buscar set" : "Search set"}
            labelHidden
            placeholder={
              isEs
                ? "Buscar por código o nombre (ej: tarkir, mkm...)"
                : "Search by code or name (e.g. tarkir, mkm...)"
            }
            prefix={<Icon source={SearchSvg} />}
            value={search}
            onChange={handleSearchChange}
            autoComplete="off"
          />
        </Card>

        {!selectedSet && recentSets.length > 0 && (
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingSm">
                {searchQuery
                  ? isEs
                    ? `Resultados para "${searchQuery}"`
                    : `Results for "${searchQuery}"`
                  : isEs
                    ? "Sets recientes"
                    : "Recent sets"}
              </Text>
              <Scrollable style={{ maxHeight: "400px" }}>
                <BlockStack gap="100">
                  {recentSets.map((set) => (
                    <Card key={set.id} padding="300">
                      <InlineStack
                        gap="200"
                        align="space-between"
                        blockAlign="center"
                      >
                        <BlockStack gap="050">
                          <Text as="h3" variant="headingSm">
                            {set.name}
                          </Text>
                          <InlineStack gap="200">
                            <Badge>{set.code.toUpperCase()}</Badge>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {set.cardCount}{" "}
                              {isEs ? "cartas" : "cards"} |{" "}
                              {set.releasedAt}
                            </Text>
                          </InlineStack>
                        </BlockStack>
                        <Button onClick={() => handleSelectSet(set.code)}>
                          {isEs ? "Seleccionar" : "Select"}
                        </Button>
                      </InlineStack>
                    </Card>
                  ))}
                </BlockStack>
              </Scrollable>
            </BlockStack>
          </Card>
        )}

        {selectedSet && (
          <>
            <Card padding="400">
              <InlineStack
                gap="300"
                align="space-between"
                blockAlign="center"
              >
                <BlockStack gap="100">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h2" variant="headingLg">
                      {selectedSet.name}
                    </Text>
                    <Badge>{selectedSet.code.toUpperCase()}</Badge>
                  </InlineStack>
                  <InlineStack gap="200">
                    <Text as="p" variant="bodySm" tone="subdued">
                      {selectedSet.cardCount}{" "}
                      {isEs ? "cartas" : "cards"}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {isEs ? "Lanzamiento:" : "Release:"}{" "}
                      {selectedSet.releasedAt}
                    </Text>
                    <Badge tone="info">{selectedSet.setType}</Badge>
                  </InlineStack>
                </BlockStack>
                <Button
                  onClick={() => {
                    const params = new URLSearchParams();
                    params.set("lang", lang);
                    submit(params, { method: "get" });
                  }}
                  variant="plain"
                >
                  {isEs ? "Cambiar set" : "Change set"}
                </Button>
              </InlineStack>
            </Card>

            <Card padding="400">
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  {isEs
                    ? `Vista previa: ${setCards.length} cartas`
                    : `Preview: ${setCards.length} cards`}
                </Text>

                <div style={{ overflowX: "auto" }}>
                  <table
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                      fontSize: "13px",
                    }}
                  >
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left", padding: "6px", borderBottom: "1px solid #dfe3e8" }}>
                          #
                        </th>
                        <th style={{ textAlign: "left", padding: "6px", borderBottom: "1px solid #dfe3e8" }}>
                          {isEs ? "Nombre" : "Name"}
                        </th>
                        <th style={{ textAlign: "left", padding: "6px", borderBottom: "1px solid #dfe3e8" }}>
                          {isEs ? "Tipo" : "Type"}
                        </th>
                        <th style={{ textAlign: "left", padding: "6px", borderBottom: "1px solid #dfe3e8" }}>
                          {isEs ? "Rareza" : "Rarity"}
                        </th>
                        <th style={{ textAlign: "right", padding: "6px", borderBottom: "1px solid #dfe3e8" }}>
                          USD
                        </th>
                        <th style={{ textAlign: "right", padding: "6px", borderBottom: "1px solid #dfe3e8" }}>
                          Foil
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {setCards.slice(0, 50).map((card) => (
                        <tr key={card.id}>
                          <td style={{ padding: "6px", borderBottom: "1px solid #f1f3f5", whiteSpace: "nowrap" }}>
                            {card.collectorNumber}
                          </td>
                          <td style={{ padding: "6px", borderBottom: "1px solid #f1f3f5" }}>
                            <InlineStack gap="100" blockAlign="center">
                              {card.imageUrl && (
                                <img
                                  src={card.imageUrl}
                                  alt=""
                                  style={{
                                    width: 24,
                                    height: 34,
                                    objectFit: "cover",
                                    borderRadius: 2,
                                  }}
                                />
                              )}
                              <Text as="span" variant="bodySm" fontWeight="semibold">
                                {card.name}
                              </Text>
                            </InlineStack>
                          </td>
                          <td style={{ padding: "6px", borderBottom: "1px solid #f1f3f5", fontSize: "12px" }}>
                            {card.typeLine}
                          </td>
                          <td style={{ padding: "6px", borderBottom: "1px solid #f1f3f5" }}>
                            {rarityBadge(card.rarity)}
                          </td>
                          <td style={{ padding: "6px", borderBottom: "1px solid #f1f3f5", textAlign: "right" }}>
                            {formatPrice(card.usdPrice)}
                          </td>
                          <td style={{ padding: "6px", borderBottom: "1px solid #f1f3f5", textAlign: "right" }}>
                            {card.hasFoil ? formatPrice(card.usdFoilPrice) : "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {setCards.length > 50 && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {isEs
                      ? `Mostrando 50 de ${setCards.length} cartas`
                      : `Showing 50 of ${setCards.length} cards`}
                  </Text>
                )}
              </BlockStack>
            </Card>

            <Card padding="400">
              <Form method="post">
                <BlockStack gap="300">
                  <Text as="h3" variant="headingMd">
                    {isEs ? "Configuración de importación" : "Import settings"}
                  </Text>

                  <Text as="p" variant="bodyMd" tone="subdued">
                    {isEs
                      ? "Cada carta se creará como producto separado para foil y no-foil según disponibilidad. La importación corre en segundo plano y podrás ver el progreso aquí."
                      : "Each card will be created as separate products for foil and nonfoil when available. The import runs in the background and you can track its progress here."}
                  </Text>
                  <div style={{ minWidth: 200 }}>
                    <Select
                      label={isEs ? "Estado del producto" : "Product status"}
                      value={createAsActive ? "true" : "false"}
                      onChange={(value) => setCreateAsActive(value === "true")}
                      options={[
                        {
                          label: isEs ? "Borrador (revisar antes)" : "Draft (review first)",
                          value: "false",
                        },
                        {
                          label: isEs ? "Activo (publicar directo)" : "Active (publish now)",
                          value: "true",
                        },
                      ]}
                    />
                    <input type="hidden" name="createAsActive" value={createAsActive ? "true" : "false"} />
                  </div>

                  <input type="hidden" name="setCode" value={selectedSet.code} />
                  <input type="hidden" name="intent" value="import" />

                  {actionData?.alreadyRunning && activeJob && (
                    <Banner tone="warning">
                      {isEs
                        ? "Ya hay una importación de este set en curso."
                        : "There is already an import in progress for this set."}
                    </Banner>
                  )}

                  <Button
                    submit
                    variant="primary"
                    loading={isSubmitting}
                    disabled={isSubmitting || isActive}
                  >
                    {isSubmitting
                      ? isEs
                        ? "Encolando..."
                        : "Queuing..."
                      : isEs
                        ? "Importar productos (foil + no-foil)"
                        : `Import products (foil + non-foil)`}
                  </Button>
                </BlockStack>
              </Form>
            </Card>
          </>
        )}

        {(isSubmitting || isActive) && activeJob && (
          <Card padding="400">
            <BlockStack gap="200" align="center">
              <Icon source={LoaderSvg} />
              <InlineStack gap="200" blockAlign="center">
                <Text as="p" variant="bodyMd">
                  {isEs
                    ? `Importando ${activeJob.setCode.toUpperCase()} a Shopify...`
                    : `Importing ${activeJob.setCode.toUpperCase()} into Shopify...`}
                </Text>
                {jobStatusBadge(activeJob)}
              </InlineStack>
              <ProgressBar progress={progress} tone="primary" />
              <Text as="p" variant="bodySm" tone="subdued">
                {activeJob.processed} / {activeJob.total || "..."}{" "}
                {isEs ? "procesados" : "processed"}
              </Text>
            </BlockStack>
          </Card>
        )}

        {activeJob && activeJob.status === "completed" && (
          <Card padding="400">
            <BlockStack gap="200">
              <Banner tone="success">
                {isEs
                  ? `Importación completada para ${activeJob.setCode.toUpperCase()}: ${activeJob.created} creadas, ${activeJob.skipped} omitidas, ${activeJob.failed} fallos`
                  : `Import complete for ${activeJob.setCode.toUpperCase()}: ${activeJob.created} created, ${activeJob.skipped} skipped, ${activeJob.failed} failed`}
              </Banner>
              {activeJob.errors.length > 0 && (
                <BlockStack gap="100">
                  <Text as="h4" variant="headingSm" tone="critical">
                    {isEs ? "Errores:" : "Errors:"}
                  </Text>
                  {activeJob.errors.slice(0, 10).map((e, i) => (
                    <Text key={i} as="p" variant="bodySm" tone="critical">
                      {e.card}: {e.error}
                    </Text>
                  ))}
                  {activeJob.errors.length > 10 && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {isEs
                        ? `...y ${activeJob.errors.length - 10} errores más`
                        : `...and ${activeJob.errors.length - 10} more errors`}
                    </Text>
                  )}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        )}

        {activeJob && activeJob.status === "failed" && (
          <Card padding="400">
            <Banner tone="critical">
              {isEs
                ? `La importación de ${activeJob.setCode.toUpperCase()} falló.`
                : `The import of ${activeJob.setCode.toUpperCase()} failed.`}
              {activeJob.message ? ` ${activeJob.message}` : ""}
            </Banner>
          </Card>
        )}

        {activeJob && !isActive && activeJob.status !== "completed" && activeJob.status !== "failed" && (
          <Card padding="400">
            <Banner tone="warning">
              {isEs ? "Estado desconocido" : "Unknown state"}: {activeJob.status}
            </Banner>
          </Card>
        )}

        {jobs.length > 0 && (
          <Card padding="400">
            <BlockStack gap="200">
              <Text as="h3" variant="headingMd">
                {isEs ? "Importaciones recientes" : "Recent imports"}
              </Text>
              <Scrollable style={{ maxHeight: "300px" }}>
                <BlockStack gap="100">
                  {jobs.map((job) => (
                    <Card key={job.id} padding="200">
                      <InlineStack
                        gap="200"
                        align="space-between"
                        blockAlign="center"
                      >
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="p" variant="bodyMd" fontWeight="semibold">
                            {job.setCode.toUpperCase()}
                          </Text>
                          {jobStatusBadge(job)}
                        </InlineStack>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {job.createdAt.slice(0, 16).replace("T", " ")}
                        </Text>
                        <Button
                          variant={activeJobId === job.id ? "primary" : "plain"}
                          onClick={() => handleSelectJob(job.id)}
                        >
                          {activeJobId === job.id ? (isEs ? "Viendo" : "Viewing") : isEs ? "Ver" : "View"}
                        </Button>
                      </InlineStack>
                    </Card>
                  ))}
                </BlockStack>
              </Scrollable>
            </BlockStack>
          </Card>
        )}

        {actionData?.error && (
          <Banner tone="critical">{actionData.error}</Banner>
        )}
      </BlockStack>
    </Page>
  );
}
