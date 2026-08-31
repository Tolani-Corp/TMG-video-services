import fs from "node:fs";

for (const name of ["TMG_IMAGE_ACCEPT_WORKER", "TMG_IMAGE_ACCEPT_R2_BUCKET", "TMG_IMAGE_ACCEPT_WORKFLOW"]) {
  if (!process.env[name]) throw new Error(`missing ${name}`);
}

const config = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: process.env.TMG_IMAGE_ACCEPT_WORKER,
  main: "src/index.ts",
  compatibility_date: "2026-08-24",
  compatibility_flags: ["nodejs_compat"],
  workers_dev: true,
  vars: {
    TMG_PUBLIC_API_ENABLED: "false",
    TMG_MCP_ENABLED: "false",
    TMG_PRODUCTION_REQUEST_API_ENABLED: "false",
    TMG_MARKETING_DISCOVERY_ENABLED: "false",
    TMG_MARKETING_VIDEO_GENERATION_ENABLED: "false",
    TMG_IMAGE_RUNTIME_ENABLED: "true",
    TMG_INGEST_WORKFLOW_ENABLED: "false",
    TMG_INGESTION_MODE: "fixture_only",
    TMG_POLICY_VERSION: "2026-08-24.image-acceptance.v1",
    TMG_EMBEDDING_DIMENSIONS: "512",
    TMG_EMBEDDING_PROVIDER_ID: "fixture",
    TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED: "false",
    TMG_PROVIDER_ACCEPTANCE_STATE: "unverified",
    TMG_TENANT_USAGE_LEDGER_ENABLED: "false",
  },
  images: { binding: "IMAGES" },
  r2_buckets: [{ binding: "MEDIA_BUCKET", bucket_name: process.env.TMG_IMAGE_ACCEPT_R2_BUCKET }],
  workflows: [{
    name: process.env.TMG_IMAGE_ACCEPT_WORKFLOW,
    binding: "IMAGE_WORKFLOW",
    class_name: "ImageProcessingWorkflow",
  }],
  observability: { enabled: true, head_sampling_rate: 1 },
};

fs.writeFileSync(".wrangler.image.acceptance.json", JSON.stringify(config, null, 2) + "\n");
console.log("rendered isolated TMG Image Runtime acceptance config");
