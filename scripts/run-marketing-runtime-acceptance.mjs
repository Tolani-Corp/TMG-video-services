import fs from "node:fs";

const baseUrl = process.env.TMG_MARKETING_ACCEPT_BASE_URL?.replace(/\/$/, "");
if (!baseUrl) {
  console.error("missing TMG_MARKETING_ACCEPT_BASE_URL");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestJson(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = { raw: body.slice(0, 2000) };
  }
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(parsed).slice(0, 2000)}`);
  }
  return parsed;
}

const create = await requestJson("/v1/production/requests", {
  method: "POST",
  body: JSON.stringify({
    tenantId: "marketing_acceptance",
    title: "TMG Launchpad marketing runtime acceptance",
    deliverables: ["campaign_plan", "branded_marketing_videos", "social_copy"],
  }),
});
const requestId = create.productionRequest?.requestId;
if (!requestId) throw new Error("acceptance request did not return requestId");

async function setReference(itemId, value) {
  return requestJson(`/v1/production/requests/${requestId}/items/${itemId}/reference`, {
    method: "POST",
    body: JSON.stringify({ value }),
  });
}

await setReference(
  "project_brief",
  "Create a grounded launch campaign for the synthetic TMG Launchpad fixture. Produce review-ready TikTok, YouTube Shorts, and website hero variants. Do not invent claims.",
);
await setReference("source_media", {
  type: "website",
  url: `${baseUrl}/__acceptance/marketing-fixture`,
  authorization: {
    authorizedByRequester: true,
    assetReuseAuthorized: true,
    authenticatedCrawlAuthorized: false,
  },
  crawlScope: {
    includePaths: [],
    excludePaths: [],
    allowSubdomains: false,
    maxPages: 5,
    maxDiscoveryDepth: 1,
  },
});
await setReference(
  "rights_evidence",
  "rights://tmg/marketing-runtime-acceptance/synthetic-fixture-v1",
);
await setReference("distribution_targets", {
  targets: [
    { platform: "tiktok", surface: "organic", usage: "organic" },
    { platform: "youtube", surface: "shorts", usage: "organic" },
    { platform: "website", surface: "hero_video", usage: "owned_media" },
  ],
});

const submit = await requestJson(`/v1/production/requests/${requestId}/submit`, {
  method: "POST",
  body: "{}",
});
const workflowInstanceId = submit.workflowInstanceId;
if (!workflowInstanceId) throw new Error("acceptance submit did not return workflowInstanceId");

function writeEvidence(finalStatus) {
  const evidence = {
    schemaVersion: "tmg.marketing-runtime-acceptance-request.v1",
    requestId,
    tenantId: "marketing_acceptance",
    workflowInstanceId,
    finalStatus,
    distributionTargets: ["tiktok.organic.v1", "youtube.short.v1", "web.hero.v1"],
    publicationAuthority: false,
    externalDistributionAuthority: false,
  };
  fs.writeFileSync("marketing-acceptance-request.json", JSON.stringify(evidence, null, 2) + "\n");
  return evidence;
}

writeEvidence("submitted");

let finalSnapshot;
for (let attempt = 0; attempt < 360; attempt += 1) {
  const state = await requestJson(`/v1/production/requests/${requestId}`);
  finalSnapshot = state.productionRequest;
  if (finalSnapshot?.status === "completed") break;
  if (finalSnapshot?.status === "failed") {
    writeEvidence("failed");
    throw new Error("marketing runtime acceptance request entered failed state");
  }
  await sleep(5000);
}
if (finalSnapshot?.status !== "completed") {
  writeEvidence(finalSnapshot?.status ?? "unknown");
  throw new Error(`marketing runtime acceptance timed out in state ${String(finalSnapshot?.status)}`);
}

const evidence = writeEvidence(finalSnapshot.status);
console.log(JSON.stringify(evidence));