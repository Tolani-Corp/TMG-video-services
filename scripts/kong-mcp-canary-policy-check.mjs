import fs from "node:fs";

const request = JSON.parse(fs.readFileSync("config/kong-mcp-canary-request.json", "utf8"));
const source = fs.readFileSync("src/kong-mcp-canary.ts", "utf8");
const renderer = fs.readFileSync("scripts/render-kong-mcp-canary-config.mjs", "utf8");

const fail = (message) => { console.error(`Kong MCP canary policy violation: ${message}`); process.exit(1); };

if (request.schema_version !== 1) fail("unsupported request schema");
if (request.authority !== "reviewed-gitops-request") fail("authority must be reviewed-gitops-request");
if (!['deploy', 'rollback'].includes(request.mode)) fail("mode must be deploy or rollback");
if (request.mode === 'deploy' && request.confirmation !== 'DEPLOY TMG KONG MCP CANARY') fail("deploy confirmation mismatch");
if (request.mode === 'rollback' && request.confirmation !== 'ROLLBACK TMG KONG MCP CANARY') fail("rollback confirmation mismatch");
if (request.worker_name !== "tmg-video-kong-mcp-canary") fail("worker name drift");
if (request.environment !== "development") fail("canary must remain in development environment");
if (request.rollback_required !== true) fail("rollback must be mandatory");

const runtime = request.required_runtime ?? {};
for (const [key, expected] of Object.entries({
  workers_dev: true,
  public_api_enabled: false,
  mcp_enabled: true,
  external_provider_egress_enabled: false,
  tool_execution_enabled: false,
  data_bindings_present: false,
  production_authority: false,
})) {
  if (runtime[key] !== expected) fail(`runtime ${key} must equal ${expected}`);
}

for (const required of [
  'url.pathname !== "/mcp"',
  'body?.method === "tools/call"',
  'tool_execution_disabled',
  'dataBindingsPresent: false',
  'productionAuthority: false',
  'deployedSha: env.TMG_DEPLOYED_SHA',
]) {
  if (!source.includes(required)) fail(`source guard missing: ${required}`);
}

for (const required of [
  'TMG_PUBLIC_API_ENABLED: "false"',
  'TMG_MCP_ENABLED: "true"',
  'TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED: "false"',
  'TMG_INGEST_WORKFLOW_ENABLED: "false"',
  'workers_dev: true',
  'main: "src/kong-mcp-canary.ts"',
]) {
  if (!renderer.includes(required)) fail(`renderer guard missing: ${required}`);
}

for (const forbidden of ['r2_buckets', 'vectorize:', 'workflows:', 'durable_objects']) {
  if (renderer.includes(forbidden)) fail(`canary renderer must not declare ${forbidden}`);
}

console.log(`Kong MCP canary policy accepted: ${request.mode} ${request.request_id}`);
