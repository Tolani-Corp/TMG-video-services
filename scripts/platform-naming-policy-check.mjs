import fs from "node:fs";
import path from "node:path";

const failures = [];
const warnings = [];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    failures.push(`${file}: ${error instanceof Error ? error.message : "invalid JSON"}`);
    return {};
  }
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full.replaceAll("\\", "/"));
  }
  return out;
}

const policy = readJson("config/platform-naming-policy.json");
const pkg = readJson("package.json");
const wrangler = readJson("wrangler.jsonc");
const enterprise = readJson("config/enterprise-service.json");
const ecosystem = readJson("config/ecosystem-policy-binding.json");
const publicContext = readJson("config/public-product-context.json");

const schemaPattern = new RegExp(policy.schemaCompatibility?.newSchemaPattern ?? "^$");
const bindingPattern = new RegExp(policy.resourceNaming?.bindingPattern ?? "^$");
const resourcePattern = new RegExp(policy.resourceNaming?.cloudflareResourcePattern ?? "^$");
const codeFilePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.(?:test|spec))?\.(?:ts|js|mjs|cjs|sh)$/;
const workflowFilePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*\.ya?ml$/;
const configFilePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.schema)?\.(?:json|jsonc|sha256)$/;
const wranglerProfilePattern = /^wrangler\.[a-z0-9]+(?:-[a-z0-9]+)*\.jsonc$/;
const envNamePattern = /^[A-Z][A-Z0-9_]*$/;

if (pkg.name !== policy.service?.packageName) failures.push(`package.json name must be ${policy.service?.packageName}`);
if (enterprise.serviceId !== policy.service?.serviceId) failures.push(`enterprise serviceId must be ${policy.service?.serviceId}`);
if (enterprise.registryAuthority !== policy.service?.enterpriseRegistryAuthority) failures.push("enterprise registryAuthority drifted from the platform naming policy");
if (wrangler.name !== policy.service?.workerName) failures.push(`default Worker name must be ${policy.service?.workerName}`);
if (publicContext.canonicalRepo !== policy.service?.repository) failures.push("public-product-context canonicalRepo drifted from platform policy");
if (ecosystem.canonicalPortfolioAuthority !== policy.service?.canonicalPortfolioAuthority) failures.push("ecosystem policy binding canonical authority drifted from platform policy");
if (publicContext.entityId !== "tolani.tmg-video") failures.push("public-product-context entityId must use canonical service id tolani.tmg-video");
if (ecosystem.bindingId !== "tolani.tmg-video.ecosystem-policy.v1") failures.push("ecosystem policy bindingId must use canonical dotted/kebab service namespace");
if (enterprise.productionAuthority !== false) failures.push("enterprise-service productionAuthority must remain false in this naming-only increment");

for (const file of listFiles("src").concat(listFiles("scripts"), listFiles("tests"))) {
  const base = path.basename(file);
  if (!codeFilePattern.test(base)) failures.push(`${file}: code/test/script filename must be kebab-case`);
}
for (const file of listFiles(".github/workflows")) {
  const base = path.basename(file);
  if (!workflowFilePattern.test(base)) failures.push(`${file}: workflow filename must be kebab-case`);
}
for (const file of listFiles("config")) {
  const base = path.basename(file);
  if (!configFilePattern.test(base) && !wranglerProfilePattern.test(base)) {
    failures.push(`${file}: config filename must be kebab-case or wrangler.<kebab-profile>.jsonc`);
  }
}

const rootVars = wrangler.vars ?? {};
const productionVars = wrangler.env?.production?.vars ?? {};
for (const [scope, vars] of [["default", rootVars], ["production", productionVars]]) {
  for (const [name, value] of Object.entries(vars)) {
    if (!envNamePattern.test(name)) failures.push(`${scope} env var ${name} must be SCREAMING_SNAKE_CASE`);
    if (name.startsWith("TMG_") && name.endsWith(policy.runtime?.booleanFlagSuffix ?? "_ENABLED")) {
      if (!(policy.runtime?.booleanFlagValues ?? ["true", "false"]).includes(String(value))) failures.push(`${scope} feature flag ${name} must be explicit string true/false`);
    }
  }
}

for (const name of policy.runtime?.requiredProductionVars ?? []) {
  if (!(name in productionVars)) failures.push(`production vars must explicitly declare ${name}; undefined is not an accepted disabled state`);
}
for (const name of policy.runtime?.productionMustRemainFalse ?? []) {
  if (productionVars[name] !== "false") failures.push(`production ${name} must remain explicitly false`);
}
if (productionVars.TOLANI_RUNTIME_ENV !== "production") failures.push("production TOLANI_RUNTIME_ENV must equal production");
if (rootVars.TOLANI_RUNTIME_ENV !== "development") failures.push("default TOLANI_RUNTIME_ENV must equal development");
if (productionVars.TMG_INGESTION_MODE !== "fixture_only") failures.push("production ingestion mode must remain fixture_only");
if (productionVars.TMG_PROVIDER_ACCEPTANCE_STATE !== "unverified") failures.push("production provider acceptance must remain unverified");
if (productionVars.TMG_MARKETING_VIDEO_PROVIDER_ACCEPTANCE_STATE !== "unverified") failures.push("production marketing video provider acceptance must remain unverified");

const requiredRoutes = ["/health", "/v1/*", "/mcp*", "/internal/*"];
const workerFirst = new Set(wrangler.assets?.run_worker_first ?? []);
for (const route of requiredRoutes) if (!workerFirst.has(route)) failures.push(`assets.run_worker_first must include ${route}`);

for (const binding of [
  ...(wrangler.durable_objects?.bindings ?? []).map((item) => item.name),
  ...(wrangler.vectorize ?? []).map((item) => item.binding),
  ...(wrangler.r2_buckets ?? []).map((item) => item.binding),
  ...(wrangler.workflows ?? []).map((item) => item.binding),
]) {
  if (!bindingPattern.test(binding)) failures.push(`binding ${binding} must be SCREAMING_SNAKE_CASE`);
}

for (const name of [
  ...(wrangler.vectorize ?? []).map((item) => item.index_name),
  ...(wrangler.r2_buckets ?? []).map((item) => item.bucket_name),
  ...(wrangler.workflows ?? []).map((item) => item.name),
  ...(wrangler.env?.production?.vectorize ?? []).map((item) => item.index_name),
  ...(wrangler.env?.production?.r2_buckets ?? []).map((item) => item.bucket_name),
  ...(wrangler.env?.production?.workflows ?? []).map((item) => item.name),
]) {
  if (name && !resourcePattern.test(name)) failures.push(`Cloudflare resource ${name} does not match canonical tmg-*-<environment> naming`);
}

const schemaLiteral = /schemaVersion\s*[:=]\s*(?:z\.literal\()?\s*["'`]([^"'`]+)["'`]/g;
for (const file of listFiles("src").concat(listFiles("scripts"))) {
  const text = fs.readFileSync(file, "utf8");
  for (const match of text.matchAll(schemaLiteral)) {
    const value = match[1];
    if (/^\d+\.\d+\.\d+$/.test(value)) {
      warnings.push(`${file}: legacy plain-semver schema ${value} retained for compatibility; successors must be namespaced`);
    } else if (!schemaPattern.test(value)) {
      failures.push(`${file}: schemaVersion ${value} must use tmg.*.vN or tolani.*.vN namespace`);
    }
  }
}

if (failures.length) {
  console.error("platform-naming-policy:check failed");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
for (const warning of warnings) console.warn(`platform-naming-policy warning: ${warning}`);
console.log(`platform-naming-policy:check passed (${warnings.length} legacy schema compatibility warning(s))`);
