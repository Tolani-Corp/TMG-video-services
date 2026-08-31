import fs from "node:fs";

const required = [
  "TMG_MARKETING_STORYBOARD_CONTEXT_WORKER",
  "TMG_MARKETING_STORYBOARD_RENDER_WORKER",
  "TMG_MARKETING_STORYBOARD_R2_BUCKET",
  "TMG_MARKETING_STORYBOARD_CONTEXT_WORKFLOW",
  "TMG_MARKETING_STORYBOARD_RENDER_WORKFLOW",
];

for (const name of required) {
  if (!process.env[name]) {
    console.error(`missing required environment variable ${name}`);
    process.exit(1);
  }
}

const shared = {
  $schema: "node_modules/wrangler/config-schema.json",
  compatibility_date: "2026-08-24",
  compatibility_flags: ["nodejs_compat"],
  workers_dev: true,
  r2_buckets: [
    {
      binding: "MEDIA_BUCKET",
      bucket_name: process.env.TMG_MARKETING_STORYBOARD_R2_BUCKET,
    },
  ],
  observability: {
    enabled: true,
    head_sampling_rate: 1,
  },
};

const contextConfig = {
  ...shared,
  name: process.env.TMG_MARKETING_STORYBOARD_CONTEXT_WORKER,
  main: "src/index.ts",
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
    TMG_FIRECRAWL_ZERO_DATA_RETENTION_MODE: "best_effort",
    TMG_MARKETING_VIDEO_GENERATION_ENABLED: "false",
    TMG_MARKETING_VIDEO_PROVIDER_ID: "pruna/p-video",
    TMG_MARKETING_VIDEO_PROVIDER_ACCEPTANCE_STATE: "unverified",
    TMG_MARKETING_ACCEPTANCE_FIXTURE_ENABLED: "true",
    TMG_IMAGE_RUNTIME_ENABLED: "false",
    TMG_INGEST_WORKFLOW_ENABLED: "false",
    TMG_INGESTION_MODE: "fixture_only",
    TMG_POLICY_VERSION: "2026-08-24.storyboard-acceptance.v1",
    TMG_EMBEDDING_DIMENSIONS: "512",
    TMG_EMBEDDING_PROVIDER_ID: "fixture",
    TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED: "false",
    TMG_PROVIDER_ACCEPTANCE_STATE: "unverified",
    TMG_TENANT_USAGE_LEDGER_ENABLED: "false",
  },
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
      name: process.env.TMG_MARKETING_STORYBOARD_CONTEXT_WORKFLOW,
      binding: "PRODUCTION_WORKFLOW",
      class_name: "ProductionWorkflow",
    },
  ],
};

const rendererConfig = {
  ...shared,
  name: process.env.TMG_MARKETING_STORYBOARD_RENDER_WORKER,
  main: "src/marketing-storyboard-workflow.ts",
  vars: {
    TMG_POLICY_VERSION: "2026-08-24.storyboard-acceptance.v1",
  },
  ai: {
    binding: "AI",
  },
  workflows: [
    {
      name: process.env.TMG_MARKETING_STORYBOARD_RENDER_WORKFLOW,
      binding: "STORYBOARD_WORKFLOW",
      class_name: "MarketingStoryboardWorkflow",
    },
  ],
};

fs.writeFileSync(
  ".wrangler.marketing.storyboard.context.json",
  JSON.stringify(contextConfig, null, 2) + "\n",
);
fs.writeFileSync(
  ".wrangler.marketing.storyboard.renderer.json",
  JSON.stringify(rendererConfig, null, 2) + "\n",
);
console.log("rendered isolated TMG Workers AI storyboard acceptance configs");
