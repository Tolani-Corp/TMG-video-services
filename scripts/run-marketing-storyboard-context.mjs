import fs from "node:fs";

const baseUrl = process.env.TMG_MARKETING_STORYBOARD_BASE_URL?.replace(/\/$/, "");
if (!baseUrl) {
  console.error("missing TMG_MARKETING_STORYBOARD_BASE_URL");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isTransientWorkersDevNotFound(response, body) {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return (
    response.status === 404 &&
    contentType.includes("text/html") &&
    /<title>Page not found<\/title>/i.test(body)
  );
}

async function requestJson(path, init = {}) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const body = await response.text();
    if (isTransientWorkersDevNotFound(response, body) && attempt < 20) {
      await sleep(1000);
      continue;
    }
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
  throw new Error(`${init.method ?? "GET"} ${path} exhausted workers.dev routing retries`);
}

const create = await requestJson("/v1/production/requests", {
  method: "POST",
  body: JSON.stringify({
    tenantId: "storyboard_acceptance",
    title: "TMG Launchpad Workers AI storyboard acceptance",
    deliverables: ["campaign_plan", "social_copy"],
  }),
});
const requestId = create.productionRequest?.requestId;
if (!requestId) throw new Error("storyboard context request did not return requestId");

async function setReference(itemId, value) {
  return requestJson(`/v1/production/requests/${requestId}/items/${itemId}/reference`, {
    method: "POST",
    body: JSON.stringify({ value }),
  });
}

await setReference(
  "project_brief",
  "Create grounded campaign context and target-aware creative planning for a free-neuron storyboard preview. Produce TikTok, YouTube Shorts, and website hero concepts. Do not invent claims.",
);
await setReference("source_media", {
  type: "website",
  url: `${baseUrl}/__acceptance/marketing-fixture`,
  authorization: {
    authorizedByRequester: true,
    assetReuseAuthorized: false,
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
  "rights://tmg/marketing-storyboard-acceptance/synthetic-fixture-v1",
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
if (!workflowInstanceId) throw new Error("storyboard context submit did not return workflowInstanceId");

function writeEvidence(finalStatus) {
  const creativeBriefKey = `tenants/storyboard_acceptance/production-requests/${requestId}/marketing/creative-brief-v1.json`;
  const evidence = {
    schemaVersion: "tmg.marketing-storyboard-context-acceptance.v1",
    requestId,
    tenantId: "storyboard_acceptance",
    workflowInstanceId,
    creativeBriefKey,
    finalStatus,
    distributionTargets: ["tiktok.organic.v1", "youtube.short.v1", "web.hero.v1"],
    humanReviewRequired: true,
    publicationAuthority: false,
    externalDistributionAuthority: false,
  };
  fs.writeFileSync("storyboard-context-request.json", JSON.stringify(evidence, null, 2) + "\n");
  return evidence;
}

writeEvidence("submitted");
let finalSnapshot;
for (let attempt = 0; attempt < 180; attempt += 1) {
  const state = await requestJson(`/v1/production/requests/${requestId}`);
  finalSnapshot = state.productionRequest;
  if (finalSnapshot?.status === "completed") break;
  if (finalSnapshot?.status === "failed") {
    writeEvidence("failed");
    throw new Error("storyboard context request entered failed state");
  }
  await sleep(5000);
}
if (finalSnapshot?.status !== "completed") {
  writeEvidence(finalSnapshot?.status ?? "unknown");
  throw new Error(`storyboard context acceptance timed out in state ${String(finalSnapshot?.status)}`);
}

const evidence = writeEvidence(finalSnapshot.status);
console.log(JSON.stringify(evidence));
