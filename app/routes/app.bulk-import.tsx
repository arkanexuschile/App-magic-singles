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
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  Icon,
  InlineStack,
  Page,
  Scrollable,
  Text,
  TextField,
  ProgressBar,
  Select,
} from "@shopify/polaris";
import { useCallback, useEffect, useRef, useState } from "react";
import { authenticate } from "../shopify.server";
import { detectLanguage } from "../utils/i18n";
import {
  listScryfallSets,
  searchScryfallSets,
  getScryfallSet,
  fetchAllCards,
} from "../services/set-importer.server";
import { buildCatalogBuffer, parseImportBuffer } from "../services/bulk-import.server";
import {
  enqueueSetImport,
  listSetImportJobs,
  getSetImportJob,
  cancelSetImportJob,
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
  const jobId = url.searchParams.get("job") || "";

  let sets: Array<{ code: string; name: string }> = [];
  if (searchQuery) {
    sets = (await searchScryfallSets(searchQuery)).map((s) => ({
      code: s.code,
      name: s.name,
    }));
  } else {
    sets = (await listScryfallSets()).map((s) => ({ code: s.code, name: s.name }));
  }

  const jobs = await listSetImportJobs(session.shop);
  const currentJob = jobId ? await getSetImportJob(jobId, session.shop) : null;

  return json({ lang, sets, searchQuery, jobs, currentJob });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "cancel") {
    const jobId = formData.get("jobId") as string;
    await cancelSetImportJob(jobId, session.shop);
    return json({ ok: true });
  }

  const createAsActive = formData.get("createAsActive") === "true";
  const accessToken = session.accessToken;
  if (!accessToken) {
    return json({ error: "Missing shop access token" }, { status: 401 });
  }

  if (intent === "import") {
    const file = formData.get("file") as File | null;
    if (!file) {
      return json({ error: "No se seleccionó ningún archivo." }, { status: 400 });
    }
    const buffer = await file.arrayBuffer();
    let groups;
    try {
      groups = parseImportBuffer(buffer);
    } catch (e) {
      return json({ error: (e as Error).message }, { status: 400 });
    }
    if (groups.length === 0) {
      return json({ error: "El Excel no tiene cartas marcadas en la columna INCLUIR." }, { status: 400 });
    }

    const enqueued: Array<{ setCode: string; cardIds: string[]; total: number }> = [];
    for (const group of groups) {
      const setInfo = await getScryfallSet(group.setCode);
      if (!setInfo) {
        continue;
      }
      const { job, alreadyRunning } = await enqueueSetImport({
        setCode: group.setCode,
        createAsActive,
        lang: "all",
        cardIds: group.cardIds,
        adminGraphql: admin.graphql,
        shop: session.shop,
        accessToken,
      });
      enqueued.push({ setCode: group.setCode, cardIds: group.cardIds, total: group.cardIds.length });
      void job;
      void alreadyRunning;
    }

    return json({ enqueued });
  }

  return json({ error: "Acción no válida." }, { status: 400 });
};

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

export default function BulkImportPage() {
  const { lang, sets, searchQuery, jobs, currentJob } = useLoaderData<typeof loader>();
  const actionData = useActionData<{
    enqueued?: Array<{ setCode: string; cardIds: string[]; total: number }>;
    error?: string;
  }>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const fetcher = useFetcher<typeof loader>();
  const isEs = lang === "es";

  const [search, setSearch] = useState(searchQuery);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [createAsActive, setCreateAsActive] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(currentJob?.id ?? null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const isExporting =
    navigation.state === "loading" && navigation.location?.pathname === "/app/bulk-import/catalog";
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

  useEffect(() => {
    if (actionData?.enqueued) {
      setActiveJobId(null);
    }
  }, [actionData]);

  const activeJob =
    (activeJobId ? fetcher.data?.currentJob ?? null : null) ??
    (activeJobId ? currentJob : null) ??
    null;

  const isActive = activeJob?.status === "queued" || activeJob?.status === "running";

  useEffect(() => {
    if (!activeJobId || !isActive) return;
    const load = () => {
      if (fetcher.state === "loading") return;
      fetcher.load(`/app/bulk-import?job=${activeJobId}&lang=${lang}`);
    };
    const interval = setInterval(load, 2000);
    return () => clearInterval(interval);
  }, [activeJobId, isActive, lang, fetcher]);

  const handleSelectJob = useCallback(
    (jobId: string) => {
      setActiveJobId(jobId);
      fetcher.load(`/app/bulk-import?job=${jobId}&lang=${lang}`);
    },
    [lang, fetcher],
  );

  const totalCards = selected.size;

  return (
    <Page
      title={isEs ? "Importar por Excel" : "Import by Excel"}
      subtitle={
        isEs
          ? "Selecciona ediciones, descarga el catálogo, marca las cartas que tienes y sube el Excel."
          : "Select editions, download the catalog, mark the cards you own, and upload the Excel."
      }
    >
      <TitleBar title={isEs ? "Importar por Excel" : "Import by Excel"} />
      <BlockStack gap="400">
        <Card>
          <TextField
            label={isEs ? "Buscar edición" : "Search edition"}
            labelHidden
            placeholder={isEs ? "Buscar por código o nombre (ej: tarkir, mkm...)" : "Search by code or name (e.g. tarkir, mkm...)"}
            prefix={<Icon source={SearchSvg} />}
            value={search}
            onChange={handleSearchChange}
            autoComplete="off"
          />
        </Card>

        <Card>
          <BlockStack gap="300">
            <BlockStack gap="100">
              <InlineStack blockAlign="center" gap="200">
                <Text as="h3" variant="headingMd">
                  {isEs ? "Ediciones seleccionadas" : "Selected editions"}
                </Text>
                {totalCards > 0 && <Badge tone="info">{totalCards}</Badge>}
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                {isEs
                  ? "Marca las ediciones de las que compraste cartas. Los disponibles se agregan al catálogo."
                  : "Mark the editions you bought cards from. Their cards get added to the catalog."}
              </Text>
            </BlockStack>

            <Scrollable style={{ maxHeight: "320px" }}>
              <BlockStack gap="100">
                {sets.map((set) => (
                  <Card key={set.code} padding="200">
                    <InlineStack gap="200" align="space-between" blockAlign="center">
                      <Checkbox
                        label={`${set.name} (${set.code.toUpperCase()})`}
                        checked={selected.has(set.code)}
                        onChange={(v) => {
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (v) next.add(set.code);
                            else next.delete(set.code);
                            return next;
                          });
                        }}
                      />
                    </InlineStack>
                  </Card>
                ))}
              </BlockStack>
            </Scrollable>
          </BlockStack>
        </Card>

        <Card padding="400">
          <Form method="get" action={`/app/bulk-import/catalog?lang=${lang}`}>
            <input type="hidden" name="setCodes" value={Array.from(selected).join(",")} />
            <Button
              type="submit"
              variant="primary"
              loading={isExporting}
              disabled={selected.size === 0 || isExporting}
            >
              {isEs ? "Descargar catálogo (Excel)" : "Download catalog (Excel)"}
            </Button>
          </Form>
        </Card>

        <Card padding="400">
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              {isEs ? "Cargar Excel con cartas marcadas" : "Upload Excel with marked cards"}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {isEs
                ? "Marca con una X (o cualquier valor) la columna INCLUIR en las cartas que tienes, guarda y sube. Se crearán solo esas, no-foil y foil cuando existan."
                : "Mark the INCLUIR column (any value) on the cards you own, save, and upload. Only those will be created (non-foil and foil when available)."}
            </Text>

            <Form method="post" encType="multipart/form-data">
              <input type="hidden" name="intent" value="import" />
              <Select
                label={isEs ? "Estado del producto" : "Product status"}
                value={createAsActive ? "true" : "false"}
                onChange={(value) => setCreateAsActive(value === "true")}
                options={[
                  { label: isEs ? "Borrador (revisar antes)" : "Draft (review first)", value: "false" },
                  { label: isEs ? "Activo (publicar directo)" : "Active (publish now)", value: "true" },
                ]}
              />
              <input type="hidden" name="createAsActive" value={createAsActive ? "true" : "false"} />
              <input type="file" name="file" accept=".xlsx,.xls" />
              <Button submit variant="primary" loading={isSubmitting} disabled={isSubmitting || isActive}>
                {isSubmitting
                  ? isEs
                    ? "Procesando..."
                    : "Processing..."
                  : isEs
                    ? "Crear productos desde Excel"
                    : "Create products from Excel"}
              </Button>
            </Form>
          </BlockStack>
        </Card>

        {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}

        {actionData?.enqueued && (
          <Card padding="400">
            <Banner tone="success">
              {isEs
                ? `Se encolaron ${actionData.enqueued.length} edición(es).`
                : `Queued ${actionData.enqueued.length} edition(s).`}
            </Banner>
          </Card>
        )}

        {(isSubmitting || isActive) && activeJob && (
          <Card padding="400">
            <BlockStack gap="200" align="center">
              <Icon source={LoaderSvg} />
              <InlineStack gap="200" blockAlign="center">
                <Text as="p" variant="bodyMd">
                  {isEs
                    ? `Importando ${activeJob.setCode.toUpperCase()}...`
                    : `Importing ${activeJob.setCode.toUpperCase()}...`}
                </Text>
                {jobStatusBadge(activeJob)}
              </InlineStack>
              <ProgressBar progress={jobProgress(activeJob)} tone="primary" />
              <Text as="p" variant="bodySm" tone="subdued">
                {activeJob.processed} / {activeJob.total || "..."}{" "}
                {isEs ? "procesados" : "processed"}
              </Text>
              <Form method="post">
                <input type="hidden" name="intent" value="cancel" />
                <input type="hidden" name="jobId" value={activeJob.id} />
                <Button submit variant="secondary" tone="critical" size="slim">
                  {isEs ? "Cancelar" : "Cancel"}
                </Button>
              </Form>
            </BlockStack>
          </Card>
        )}

        {activeJob && activeJob.status === "completed" && (
          <Card padding="400">
            <Banner tone="success">
              {isEs
                ? `Importación de ${activeJob.setCode.toUpperCase()} completada: ${activeJob.created} creadas, ${activeJob.skipped} omitidas, ${activeJob.failed} fallos`
                : `Import for ${activeJob.setCode.toUpperCase()} complete: ${activeJob.created} created, ${activeJob.skipped} skipped, ${activeJob.failed} failed`}
            </Banner>
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
                      <InlineStack gap="200" align="space-between" blockAlign="center">
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
      </BlockStack>
    </Page>
  );
}
