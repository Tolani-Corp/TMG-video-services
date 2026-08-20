import fs from "node:fs";

const required = [
  "TMG_ACCEPT_WORKER",
  "TMG_ACCEPT_R2_BUCKET",
  "TMG_ACCEPT_VECTOR_INDEX",
  "TMG_ACCEPT_INGEST_WORKFLOW",
  "TMG_ACCEPT_REVOKE_WORKFLOW",
];

for (const name of required) {
  if (!process.env[name]) {
    console.error(`missing required environment variable ${name}`);
    process.exit(1);
  }
}

const config = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: process.env.TMG_ACCEPT_WORKER,
  main: "src/index.ts",
  compatibility_date: "2026-08-20",
  compatibility_flags: ["nodejs_compat"],
  workers_dev: false,
  vars: {
    TMG_PUBLIC_API_ENABLED: "false",
    TMG_MCP_ENABLED: "false",
    TMG_INGEST_WORKFLOW_ENABLED: "true",
    TMG_INGESTION_MODE: "fixture_only",
    TMG_POLICY_VERSION: "2026-08-20.acceptance.v1",
    TMG_EMBEDDING_DIMENSIONS: "512",
  },
  vectorize: [
    {
      binding: "VIDEO_INDEX",
      index_name: process.env.TMG_ACCEPT_VECTOR_INDEX,
    },
  ],
  r2_buckets: [
    {
      binding: "MEDIA_BUCKET",
      bucket_name: process.env.TMG_ACCEPT_R2_BUCKET,
    },
  ],
  workflows: [
    {
      name: process.env.TMG_ACCEPT_INGEST_WORKFLOW,
      binding: "INGEST_WORKFLOW",
      class_name: "IngestionWorkflow",
    },
    {
      name: process.env.TMG_ACCEPT_REVOKE_WORKFLOW,
      binding: "REVOKE_WORKFLOW",
      class_name: "RevocationWorkflow",
    },
  ],
  observability: {
    enabled: true,
    head_sampling_rate: 1,
  },
};

fs.writeFileSync(".wrangler.acceptance.json", JSON.stringify(config, null, 2) + "\n");
config.vars.TMG_INGEST_WORKFLOW_ENABLED = "false";
fs.writeFileSync(".wrangler.acceptance.disabled.json", JSON.stringify(config, null, 2) + "\n");
console.log("rendered isolated acceptance Wrangler configs");
