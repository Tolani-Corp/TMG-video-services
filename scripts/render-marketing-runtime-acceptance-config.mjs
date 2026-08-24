import fs from "node:fs";

const required = [
  "TMG_MARKETING_ACCEPT_WORKER",
  "TMG_MARKETING_ACCEPT_R2_BUCKET",
  "TMG_MARKETING_ACCEPT_WORKFLOW",
];

for (const name of required) {
  if (!process.env[name]) {
    console.error(`missing required environment variable ${name}`);
    process.exit(1);
  }
}

const config = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: process.env.TMG_MARKETING_ACCEPT_WORKER,
  main: "src/index.ts",
  compatibility_date: "2026-08-24",
  compatibility_flags: ["nodejs_compat"],
  workers_dev: true,
  exports: {
    ProductionRequestCoordinator: {
      type: "durable-object",
      storage: "sqlite",
    },
  },
  vars: {
    TMG_PUBLIC_API_ENABLED: "false",
    TMG_MCP_ENABLED: "false",
    TMG_PRODUCTION_REQUEST_API_ENABLED: "true",
    TMG_MARKETING_DISCOVERY_ENABLED: "true",
    TMG_MARKETING_VIDEO_GENERATION_ENABLED: "true",
    TMG_MARKETING_VIDEO_PROVIDER_ID: "pruna/p-video",
    TMG_MARKETING_VIDEO_PROVIDER_ACCEPTANCE_STATE: "development_canary",
    TMG_MARKETING_ACCEPTANCE_FIXTURE_ENABLED: "true",
    TMG_INGEST_WORKFLOW_ENABLED: "false",
    TMG_INGESTION_MODE: "fixture_only",
    TMG_POLICY_VERSION: "2026-08-24.marketing-acceptance.v1",
    TMG_EMBEDDING_DIMENSIONS: "512",
    TMG_EMBEDDING_PROVIDER_ID: "fixture",
    TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED: "true",
    TMG_PROVIDER_ACCEPTANCE_STATE: "unverified",
    TMG_TENANT_USAGE_LEDGER_ENABLED: "false",
  },
  ai: {
    binding: "AI",
  },
  r2_buckets: [
    {
      binding: "MEDIA_BUCKET",
      bucket_name: process.env.TMG_MARKETING_ACCEPT_R2_BUCKET,
    },
  ],
  durable_objects: {
    bindings: [
      {
        name: "PRODUCTION_REQUESTS",
        class_name: "ProductionRequestCoordinator",
      },
    ],
  },
  workflows: [
    {
      name: process.env.TMG_MARKETING_ACCEPT_WORKFLOW,
      binding: "PRODUCTION_WORKFLOW",
      class_name: "ProductionWorkflow",
    },
  ],
  observability: {
    enabled: true,
    head_sampling_rate: 1,
  },
};

fs.writeFileSync(
  ".wrangler.marketing.acceptance.json",
  JSON.stringify(config, null, 2) + "\n",
);
console.log("rendered isolated TMG Marketing Runtime acceptance config");
