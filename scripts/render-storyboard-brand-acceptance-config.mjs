import fs from "node:fs";

const required = [
  "TMG_STORYBOARD_BRAND_ACCEPT_WORKER",
  "TMG_STORYBOARD_BRAND_ACCEPT_R2_BUCKET",
  "TMG_STORYBOARD_BRAND_ACCEPT_WORKFLOW",
];

for (const name of required) {
  if (!process.env[name]) {
    console.error(`missing required environment variable ${name}`);
    process.exit(1);
  }
}

const config = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: process.env.TMG_STORYBOARD_BRAND_ACCEPT_WORKER,
  main: "src/storyboard-brand-workflow.ts",
  compatibility_date: "2026-08-24",
  compatibility_flags: ["nodejs_compat"],
  workers_dev: true,
  vars: {
    TMG_POLICY_VERSION: "2026-08-24.storyboard-brand-composition.v1.1",
  },
  ai: {
    binding: "AI",
  },
  images: {
    binding: "IMAGES",
  },
  r2_buckets: [
    {
      binding: "MEDIA_BUCKET",
      bucket_name: process.env.TMG_STORYBOARD_BRAND_ACCEPT_R2_BUCKET,
    },
  ],
  workflows: [
    {
      name: process.env.TMG_STORYBOARD_BRAND_ACCEPT_WORKFLOW,
      binding: "STORYBOARD_BRAND_WORKFLOW",
      class_name: "StoryboardBrandCompositionWorkflow",
    },
  ],
  observability: {
    enabled: true,
    head_sampling_rate: 1,
  },
};

fs.writeFileSync(
  ".wrangler.storyboard-brand.acceptance.json",
  JSON.stringify(config, null, 2) + "\n",
);
console.log("rendered isolated storyboard brand composition acceptance config");
