import fs from "node:fs";

const required = ["TMG_KONG_CANARY_WORKER", "TMG_KONG_CANARY_SHA", "TMG_KONG_CANARY_ID"];
for (const name of required) {
  if (!process.env[name]) {
    console.error(`missing required environment variable ${name}`);
    process.exit(1);
  }
}

const config = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: process.env.TMG_KONG_CANARY_WORKER,
  main: "src/kong-mcp-canary.ts",
  compatibility_date: "2026-08-20",
  compatibility_flags: ["nodejs_compat"],
  workers_dev: true,
  vars: {
    TMG_PUBLIC_API_ENABLED: "false",
    TMG_MCP_ENABLED: "true",
    TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED: "false",
    TMG_INGEST_WORKFLOW_ENABLED: "false",
    TMG_INGESTION_MODE: "disabled",
    TMG_POLICY_VERSION: "2026-08-27.kong-mcp-canary.v1",
    TMG_EMBEDDING_DIMENSIONS: "512",
    TMG_DEPLOYED_SHA: process.env.TMG_KONG_CANARY_SHA,
    TMG_KONG_CANARY_ID: process.env.TMG_KONG_CANARY_ID,
  },
  observability: {
    enabled: true,
    head_sampling_rate: 1,
  },
};

fs.writeFileSync(".wrangler.kong-mcp-canary.json", JSON.stringify(config, null, 2) + "\n");
console.log(`rendered ${config.name} with exact SHA ${config.vars.TMG_DEPLOYED_SHA}`);
