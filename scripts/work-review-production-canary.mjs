import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const bucket = "tmg-work-requests-prod";
const workflow = "tmg-work-request-processing-prod";
const config = "wrangler.review.jsonc";
const runId = process.env.GITHUB_RUN_ID || Date.now().toString();
const runAttempt = process.env.GITHUB_RUN_ATTEMPT || "local";
const now = new Date();
const date = now.toISOString().slice(0, 10).replaceAll("-", "");
const requestId = `wr_${date}_${randomUUID()}`;
const fileId = `file_${randomUUID()}`;
const reviewId = `review_${randomUUID()}`;
const instanceId = `accept-${runId}-${runAttempt}-${randomUUID()}`.slice(0, 96);
const requestToken = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
const tokenHash = createHash("sha256").update(requestToken).digest("hex");
const root = mkdtempSync(join(tmpdir(), "tmg-work-review-canary-"));
const fixturePath = join(root, "workflow-canary.txt");
const manifestPath = join(root, "manifest.json");
const resultPath = join(root, "result.json");
const objectKey = `quarantine/${requestId}/files/${fileId}`;
const manifestKey = `requests/${requestId}/manifest.json`;
const fixture = Buffer.from("TMG work review durable workflow production canary\n", "utf8");
const fixtureSha = createHash("sha256").update(fixture).digest("hex");

function run(args, options = {}) {
  const result = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    encoding: "utf8",
    env: process.env,
    ...options,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    throw new Error(`wrangler ${args.join(" ")} failed with exit ${result.status}`);
  }
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function getManifest() {
  run(["r2", "object", "get", `${bucket}/${manifestKey}`, "--file", resultPath, "--remote"]);
  return JSON.parse(readFileSync(resultPath, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanup() {
  for (const key of [objectKey, manifestKey]) {
    try {
      run(["r2", "object", "delete", `${bucket}/${key}`, "--remote"]);
    } catch (error) {
      console.warn(`cleanup warning for ${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  rmSync(root, { recursive: true, force: true });
}

writeFileSync(fixturePath, fixture);
const manifest = {
  schema: "tmg.work-request.v1",
  requestId,
  status: "approved_for_processing",
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
  requester: {
    name: "TMG Production Canary",
    email: "production-canary@tolanimediagroup.com",
    organization: "Tolani Media Group",
  },
  request: {
    serviceType: "content-analysis",
    title: "Durable workflow production acceptance",
    description: "Harmless automated acceptance fixture for governed work-request workflow execution.",
    desiredOutcome: "Prove durable dispatch, R2 evidence verification, live event writing, and customer status projection.",
    targetDate: null,
  },
  rights: {
    authorizedToShare: true,
    humanReviewAcknowledged: true,
  },
  controls: {
    processingAuthorized: true,
    publicationAuthorized: false,
    externalProviderEgressAuthorized: false,
  },
  tokenHash,
  files: [
    {
      fileId,
      name: "workflow-canary.txt",
      size: fixture.byteLength,
      type: "text/plain",
      sha256: fixtureSha,
      status: "uploaded",
      objectKey,
      uploadedAt: now.toISOString(),
    },
  ],
  review: {
    state: "approved",
    reviewId,
    reviewerEmail: "production-canary@tolanimediagroup.com",
    note: "Automated governed workflow production acceptance; processing only, no publication or provider egress.",
    at: now.toISOString(),
  },
  workflow: {
    instanceId,
    dispatchState: "requested",
    phase: "authorization",
    progress: 58,
    headline: "Processing authority approved",
    summary: "Production acceptance fixture is ready for durable workflow dispatch.",
    events: [
      {
        id: `evt_${randomUUID()}`,
        at: now.toISOString(),
        phase: "authorization",
        state: "approved",
        title: "Production canary processing authority granted",
        detail: "Bounded processing-only authority for harmless automated acceptance evidence.",
      },
    ],
  },
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

let succeeded = false;
try {
  run(["r2", "object", "put", `${bucket}/${objectKey}`, "--file", fixturePath, "--content-type", "text/plain", "--remote"]);
  run(["r2", "object", "put", `${bucket}/${manifestKey}`, "--file", manifestPath, "--content-type", "application/json", "--remote"]);

  const params = JSON.stringify({ requestId, reviewId, reviewerEmail: "production-canary@tolanimediagroup.com" });
  const triggerOutput = run(["workflows", "trigger", workflow, params, "--id", instanceId, "--config", config]);
  assert(/queued successfully|created|triggered/i.test(triggerOutput), "Workflow trigger did not report a queued/created instance.");

  let resultManifest = null;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    await sleep(2000);
    resultManifest = getManifest();
    if (["action_required", "failed"].includes(resultManifest.status)) break;
  }
  assert(resultManifest, "Workflow result manifest could not be read.");
  if (resultManifest.status === "failed") {
    throw new Error(`Production Workflow reached failed state: ${JSON.stringify(resultManifest.workflow?.outcome || {})}`);
  }

  assert(resultManifest.status === "action_required", `Expected action_required, got ${resultManifest.status}`);
  assert(resultManifest.controls?.processingAuthorized === true, "Workflow unexpectedly revoked processing authority before checkpoint.");
  assert(resultManifest.controls?.publicationAuthorized === false, "Workflow unexpectedly granted publication authority.");
  assert(resultManifest.controls?.externalProviderEgressAuthorized === false, "Workflow unexpectedly granted provider egress authority.");
  assert(resultManifest.workflow?.dispatchState === "checkpoint", "Workflow did not reach checkpoint dispatch state.");
  assert(resultManifest.workflow?.phase === "action_required", "Workflow phase did not reach action_required.");
  assert(resultManifest.workflow?.progress === 82, "Workflow progress did not reach the expected 82% checkpoint.");
  assert(resultManifest.workflow?.processorId === "content-analysis", "Workflow routed to an unexpected processor.");
  assert(resultManifest.workflow?.processorState === "provider_egress_gated", "Content-analysis provider egress gate is not preserved.");
  assert(resultManifest.workflow?.outcome?.status === "action_required", "Workflow outcome checkpoint status mismatch.");

  const titles = new Set((resultManifest.workflow?.events || []).map((event) => event.title));
  for (const expected of ["Durable workflow started", "Evidence inventory verified", "Specialized processor checkpoint reached"]) {
    assert(titles.has(expected), `Missing durable workflow event: ${expected}`);
  }

  const evidence = resultManifest.workflow?.outcome?.evidence || [];
  const routeEvidence = evidence.find((item) => item.label === "Processor route");
  assert(routeEvidence?.value === "content-analysis", "Workflow outcome does not expose the expected processor-route evidence.");

  const response = await fetch(`https://tolanimediagroup.com/work-requests/${encodeURIComponent(requestId)}/status`, {
    headers: {
      accept: "application/json",
      "x-work-request-token": requestToken,
    },
  });
  const customer = await response.json().catch(() => ({}));
  assert(response.ok, `Customer status projection returned HTTP ${response.status}: ${JSON.stringify(customer)}`);
  assert(customer.schema === "tmg.work-request-processing-status.v1", "Customer processing status schema mismatch.");
  assert(customer.requestId === requestId && customer.status === "action_required", "Customer processing status request/state mismatch.");
  assert(customer.lifecycle?.phase === "action_required", "Customer lifecycle phase does not reflect the workflow checkpoint.");
  assert(customer.lifecycle?.state === "action_required", "Customer lifecycle state does not reflect action_required.");
  assert(customer.lifecycle?.progress === 82, "Customer lifecycle did not preserve workflow progress.");
  assert(customer.context?.controls?.processingAuthorized === true, "Customer view lost processing authority state.");
  assert(customer.context?.controls?.publicationAuthorized === false, "Customer view exposed publication authority.");
  assert(customer.context?.controls?.externalProviderEgressAuthorized === false, "Customer view exposed provider egress authority.");
  const customerTitles = new Set((customer.events || []).map((event) => event.title));
  for (const expected of ["Durable workflow started", "Evidence inventory verified", "Specialized processor checkpoint reached"]) {
    assert(customerTitles.has(expected), `Customer live view is missing workflow event: ${expected}`);
  }
  assert(customer.outcome?.status === "action_required", "Customer outcome status mismatch.");
  assert(customer.outcome?.headline === "Evidence verified; processor authorization checkpoint", "Customer outcome headline mismatch.");
  assert((customer.outcome?.evidence || []).some((item) => item.label === "Processor route" && item.value === "content-analysis"), "Customer outcome is missing processor-route evidence.");

  const serializedCustomer = JSON.stringify(customer);
  assert(!serializedCustomer.includes(requestToken), "Customer status leaked request token.");
  assert(!serializedCustomer.includes(tokenHash), "Customer status leaked token hash.");
  assert(!serializedCustomer.includes(objectKey), "Customer status leaked private R2 object key.");
  assert(!serializedCustomer.includes("recordedBy"), "Customer status leaked internal operator attribution.");

  const describe = run(["workflows", "instances", "describe", workflow, instanceId, "--config", config, "--step-output=false"]);
  console.log(JSON.stringify({
    ok: true,
    schema: "tmg.work-review-production-canary.v1",
    requestId,
    instanceId,
    manifestStatus: resultManifest.status,
    processorId: resultManifest.workflow.processorId,
    processorState: resultManifest.workflow.processorState,
    customerPhase: customer.lifecycle.phase,
    customerProgress: customer.lifecycle.progress,
    authority: customer.context.controls,
    workflowDescribe: describe.slice(0, 2000),
  }, null, 2));
  succeeded = true;
} finally {
  await cleanup();
  if (!succeeded) console.error("TMG work-review production canary failed; temporary R2 evidence was cleaned up.");
}
