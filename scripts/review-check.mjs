import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

function mustExist(relPath, failures) {
  if (!fs.existsSync(path.join(root, relPath))) {
    failures.push(`Missing required file: ${relPath}`);
  }
}

function mustInclude(content, expected, label, failures) {
  if (!content.includes(expected)) {
    failures.push(`Missing expected config: ${label}`);
  }
}

const failures = [];
const warnings = [];

mustExist("shopify.app.toml", failures);
mustExist("app/routes/privacy.tsx", failures);
mustExist("app/routes/terms.tsx", failures);
mustExist("app/routes/support.tsx", failures);
mustExist("app/routes/webhooks.customers.data_request.tsx", failures);
mustExist("app/routes/webhooks.customers.redact.tsx", failures);
mustExist("app/routes/webhooks.shop.redact.tsx", failures);
mustExist("docs/shopify-review-submission.md", failures);

const toml = read("shopify.app.toml");
mustInclude(toml, "embedded = true", "embedded app", failures);
mustInclude(
  toml,
  'compliance_topics = [ "customers/data_request" ]',
  "customers/data_request webhook",
  failures,
);
mustInclude(
  toml,
  'compliance_topics = [ "customers/redact" ]',
  "customers/redact webhook",
  failures,
);
mustInclude(
  toml,
  'compliance_topics = [ "shop/redact" ]',
  "shop/redact webhook",
  failures,
);

const scopeMatch = toml.match(/scopes\s*=\s*"([^"]+)"/);
if (!scopeMatch) {
  failures.push("Could not find scopes in shopify.app.toml");
} else {
  const scopes = scopeMatch[1].split(",").map((s) => s.trim());
  if (!scopes.includes("read_products")) {
    failures.push("Scope read_products is required by current app logic");
  }
  if (!scopes.includes("write_products")) {
    failures.push("Scope write_products is required by current app logic");
  }
}

if (toml.includes('application_url = "https://example.com"')) {
  failures.push("application_url is still https://example.com. Set your production app URL.");
}
if (toml.includes('redirect_urls = [ "https://example.com/api/auth" ]')) {
  failures.push("redirect_urls still point to example.com. Set your production OAuth redirect URL(s).");
}

const legalFiles = ["app/routes/privacy.tsx", "app/routes/terms.tsx", "app/routes/support.tsx"];
for (const file of legalFiles) {
  const content = read(file);
  if (content.includes("support@example.com")) {
    failures.push(`Replace placeholder support email in ${file}`);
  }
  if (content.includes("support@your-domain.com")) {
    warnings.push(`Set APP_SUPPORT_EMAIL for production (${file} has fallback placeholder).`);
  }
}

const submissionDoc = read("docs/shopify-review-submission.md");
if (submissionDoc.includes("support@example.com")) {
  warnings.push("Update support email in docs/shopify-review-submission.md before submission.");
}
if (submissionDoc.includes("YOUR_APP_DOMAIN")) {
  warnings.push("Replace YOUR_APP_DOMAIN placeholders in submission document.");
}

if (failures.length > 0) {
  console.error("Review check failed:\n");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  if (warnings.length > 0) {
    console.error("\nWarnings:");
    for (const warning of warnings) {
      console.error(`- ${warning}`);
    }
  }
  process.exit(1);
}

console.log("Review check passed.");
if (warnings.length > 0) {
  console.log("\nWarnings:");
  for (const warning of warnings) {
    console.log(`- ${warning}`);
  }
}
