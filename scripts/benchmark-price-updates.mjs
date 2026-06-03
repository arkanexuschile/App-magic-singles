import { performance } from "node:perf_hooks";

const UPDATE_BATCH_SIZE = 50;
const TOTAL_UPDATES = 2000;
const DEFAULT_LATENCY_MS = 120;

function makeUpdates({ total, products }) {
  const updates = [];
  for (let index = 0; index < total; index += 1) {
    const productSlot = index % products;
    const productId = `gid://shopify/Product/${productSlot + 1}`;
    const variantId = `gid://shopify/ProductVariant/${index + 1}`;
    updates.push({
      productId,
      id: variantId,
      variantId,
      price: "9.99",
    });
  }
  return updates;
}

function groupByProduct(updates) {
  const grouped = new Map();
  for (const update of updates) {
    const current = grouped.get(update.productId) ?? [];
    current.push(update);
    grouped.set(update.productId, current);
  }
  return grouped;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runBenchmark({ updates, latencyMs }) {
  const grouped = groupByProduct(updates);
  let mutationCalls = 0;
  const start = performance.now();

  for (const productUpdates of grouped.values()) {
    for (let index = 0; index < productUpdates.length; index += UPDATE_BATCH_SIZE) {
      const batch = productUpdates.slice(index, index + UPDATE_BATCH_SIZE);
      await wait(latencyMs);
      mutationCalls += 1;
      void batch;
    }
  }

  const durationMs = performance.now() - start;
  return {
    durationMs,
    mutationCalls,
    throughput: updates.length / (durationMs / 1000),
  };
}

async function main() {
  const latencyMs = Number(process.env.BENCH_LATENCY_MS ?? DEFAULT_LATENCY_MS);
  const scenarios = [
    { name: "Worst case (2000 products x 1 variant)", products: 2000 },
    { name: "Medium case (200 products x 10 variants)", products: 200 },
    { name: "Best case (40 products x 50 variants)", products: 40 },
  ];

  console.log(`Benchmark de 2000 updates (latencia simulada=${latencyMs}ms por mutation)\n`);
  for (const scenario of scenarios) {
    const updates = makeUpdates({ total: TOTAL_UPDATES, products: scenario.products });
    const result = await runBenchmark({ updates, latencyMs });
    console.log(`- ${scenario.name}`);
    console.log(`  mutation calls: ${result.mutationCalls}`);
    console.log(`  total: ${result.durationMs.toFixed(0)} ms`);
    console.log(`  throughput: ${result.throughput.toFixed(2)} items/s\n`);
  }
}

await main();
