import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const SENTINEL = "00000000-0000-0000-0000-000000000000";
const databaseId = String(process.env.TMG_CONTROL_DB_ID || "").trim();
const zoneId = String(process.env.TMG_CONSOLE_ZONE_ID || "").trim();
const consoleHost = String(process.env.TMG_CONSOLE_HOST || "console.tolanimediagroup.com").trim();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(/^[0-9a-f-]{36}$/i.test(databaseId) && databaseId !== SENTINEL, "TMG_CONTROL_DB_ID must be a real D1 UUID");
assert(/^[0-9a-f]{32}$/i.test(zoneId), "TMG_CONSOLE_ZONE_ID must be a 32-character Cloudflare zone id");
assert(consoleHost === "console.tolanimediagroup.com", "only console.tolanimediagroup.com is authorized by this activation renderer");

const parseJsonc = (text) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
const [uiSource, apiSource] = await Promise.all([
  readFile("wrangler.jsonc", "utf8"),
  readFile("wrangler.intake-api.jsonc", "utf8"),
]);

const ui = parseJsonc(uiSource);
const api = parseJsonc(apiSource);

function activateDatabaseBinding(config) {
  const binding = config.d1_databases?.find((entry) => entry.binding === "CONTROL_DB");
  assert(binding, "CONTROL_DB binding is missing");
  assert(binding.database_name === "tmg-video-control-dev", "activation may target only the development control database");
  binding.database_id = databaseId;
  binding.migrations_dir = "migrations";
}

activateDatabaseBinding(ui);
activateDatabaseBinding(api);

ui.workers_dev = false;
ui.preview_urls = false;
ui.routes = [{ pattern: consoleHost, custom_domain: true }];
ui.vars = {
  ...ui.vars,
  TMG_INTAKE_ENABLED: "true",
  TMG_CONTROL_DB_BINDING_STATE: "provisioned",
  TMG_CONSOLE_HOST: consoleHost,
};
delete ui.env;

api.workers_dev = false;
api.preview_urls = false;
api.routes = [
  { pattern: `${consoleHost}/v1/console/*`, zone_id: zoneId },
  { pattern: `${consoleHost}/v1/intake/*`, zone_id: zoneId },
];
api.vars = {
  ...api.vars,
  TMG_INTAKE_ENABLED: "true",
  TMG_CONTROL_DB_BINDING_STATE: "provisioned",
  TMG_CONSOLE_HOST: consoleHost,
};

assert(ui.vars.TMG_PUBLIC_API_ENABLED === "false", "activation cannot enable the public API");
assert(ui.vars.TMG_MCP_ENABLED === "false", "activation cannot enable MCP");
assert(ui.vars.TMG_INGEST_WORKFLOW_ENABLED === "false", "activation cannot enable ingestion Workflow execution");
assert(ui.vars.TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED === "false", "activation cannot enable external-provider egress");
assert(api.vars.TMG_PUBLIC_API_ENABLED === "false", "intake API config cannot enable the public API");
assert(api.vars.TMG_MCP_ENABLED === "false", "intake API config cannot enable MCP");
assert(api.vars.TMG_INGEST_WORKFLOW_ENABLED === "false", "intake API config cannot enable ingestion Workflow execution");
assert(api.vars.TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED === "false", "intake API config cannot enable external-provider egress");

const outDir = path.join(".wrangler", "intake-activation");
await mkdir(outDir, { recursive: true });
await Promise.all([
  writeFile(path.join(outDir, "ui.jsonc"), `${JSON.stringify(ui, null, 2)}\n`, "utf8"),
  writeFile(path.join(outDir, "api.jsonc"), `${JSON.stringify(api, null, 2)}\n`, "utf8"),
]);

console.log(JSON.stringify({
  schema: "tmg.intake-activation-config.v1",
  consoleHost,
  databaseId,
  zoneId,
  uiWorker: ui.name,
  apiWorker: api.name,
  intakeEnabled: true,
  publicApiEnabled: false,
  mcpEnabled: false,
  ingestionWorkflowEnabled: false,
  externalProviderEgressEnabled: false,
  productionAuthority: false,
}));
