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

function run(args) {
  const result = spawnSync("pnpm", ["exec", "wrangler", ...args], { encoding: "utf8", env: process.env });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    throw new Error(`wrangler ${args.join(" ")} failed with exit ${result.status}`);
  }
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeCase({ serviceType, processorId, allowedActions, fixtureName, fixtureType, fixture }) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  const requestId = `wr_${date}_${randomUUID()}`;
  const fileId = `file_${randomUUID()}`;
  const reviewId = `review_${randomUUID()}`;
  const instanceId = `proc-${runId}-${runAttempt}-${processorId.replace(/[^a-z0-9]/gi, "-")}-${randomUUID()}`.slice(0, 96);
  const requestToken = `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
  const tokenHash = createHash("sha256").update(requestToken).digest("hex");
  const fixtureSha = createHash("sha256").update(fixture).digest("hex");
  const root = mkdtempSync(join(tmpdir(), `tmg-${processorId}-canary-`));
  const fixturePath = join(root, fixtureName);
  const manifestPath = join(root, "manifest.json");
  const resultPath = join(root, "result.json");
  const objectKey = `quarantine/${requestId}/files/${fileId}`;
  const manifestKey = `requests/${requestId}/manifest.json`;
  const cleanupKeys = [objectKey, manifestKey];

  function writeManifestRemote(manifest) {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    run(["r2", "object", "put", `${bucket}/${manifestKey}`, "--file", manifestPath, "--content-type", "application/json", "--remote"]);
  }

  function getManifest() {
    run(["r2", "object", "get", `${bucket}/${manifestKey}`, "--file", resultPath, "--remote"]);
    return JSON.parse(readFileSync(resultPath, "utf8"));
  }

  async function cleanup() {
    for (const key of cleanupKeys) {
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
      name: "TMG Processor Canary",
      email: "production-canary@tolanimediagroup.com",
      organization: "Tolani Media Group",
    },
    request: {
      serviceType,
      title: `${processorId} production continuation acceptance`,
      description: "Harmless automated acceptance fixture for processor-specific authority continuation.",
      desiredOutcome: "Prove 82% hold, exact authority consumption, local adapter execution, and customer live-view projection.",
      targetDate: null,
    },
    rights: { authorizedToShare: true, humanReviewAcknowledged: true },
    controls: { processingAuthorized: true, publicationAuthorized: false, externalProviderEgressAuthorized: false },
    tokenHash,
    files: [{
      fileId,
      name: fixtureName,
      size: fixture.byteLength,
      type: fixtureType,
      sha256: fixtureSha,
      status: "uploaded",
      objectKey,
      uploadedAt: now.toISOString(),
    }],
    review: {
      state: "approved",
      reviewId,
      reviewerEmail: "production-canary@tolanimediagroup.com",
      note: "Automated production acceptance grants request processing only; processor authority follows separately.",
      at: now.toISOString(),
    },
    processorAuthorizations: {},
    workflow: {
      instanceId,
      dispatchState: "requested",
      phase: "authorization",
      progress: 58,
      headline: "Processing authority approved",
      summary: "Production processor-authority canary is ready for durable workflow dispatch.",
      events: [],
    },
  };

  let succeeded = false;
  try {
    run(["r2", "object", "put", `${bucket}/${objectKey}`, "--file", fixturePath, "--content-type", fixtureType, "--remote"]);
    writeManifestRemote(manifest);

    const params = JSON.stringify({ requestId, reviewId, reviewerEmail: "production-canary@tolanimediagroup.com" });
    run(["workflows", "trigger", workflow, params, "--id", instanceId, "--config", config]);

    let waiting = null;
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      await sleep(1500);
      waiting = getManifest();
      if (waiting.status === "action_required" && waiting.workflow?.dispatchState === "waiting_for_processor_authority") break;
      if (waiting.status === "failed") throw new Error(`${processorId} workflow failed before processor authority checkpoint.`);
    }

    assert(waiting?.status === "action_required", `${processorId} did not reach action_required before processor authority.`);
    assert(waiting.workflow?.progress === 82, `${processorId} did not hold at 82% before processor authority.`);
    assert(waiting.workflow?.processorId === processorId, `${processorId} route mismatch.`);
    assert(waiting.workflow?.processorAuthorizationState === "required", `${processorId} did not require processor-specific authority.`);
    assert(waiting.controls?.publicationAuthorized === false, "Publication authority unexpectedly broadened before processor grant.");
    assert(waiting.controls?.externalProviderEgressAuthorized === false, "Provider egress unexpectedly broadened before processor grant.");

    const grantedAt = new Date();
    const authorityId = `pa_${randomUUID()}`;
    waiting.processorAuthorizations = {
      ...(waiting.processorAuthorizations || {}),
      [processorId]: {
        schema: "tmg.processor-authority.v1",
        authorityId,
        processorId,
        state: "authorized",
        requestId,
        serviceType,
        reviewId,
        workflowInstanceId: instanceId,
        grantedBy: "production-canary@tolanimediagroup.com",
        grantedAt: grantedAt.toISOString(),
        expiresAt: new Date(grantedAt.getTime() + 10 * 60 * 1000).toISOString(),
        localExecutionOnly: true,
        publicationAuthorized: false,
        externalProviderEgressAuthorized: false,
        allowedActions,
        evidenceBindings: [{ fileId, sha256: fixtureSha, size: fixture.byteLength }],
        note: "Harmless production canary: exact local processor authority only.",
      },
    };
    waiting.workflow.processorAuthorizationState = "authorized_event_pending";
    writeManifestRemote(waiting);

    const payload = JSON.stringify({ authorityId, processorId, reviewId });
    run(["workflows", "instances", "send-event", workflow, instanceId, "--type", "processor-authorized", "--payload", payload, "--config", config]);

    let resultManifest = null;
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      await sleep(1500);
      resultManifest = getManifest();
      if (resultManifest.workflow?.processorState === "local_adapter_complete") break;
      if (resultManifest.status === "failed") throw new Error(`${processorId} workflow entered failed state after authorization.`);
    }

    assert(resultManifest?.status === "action_required", `${processorId} did not return to a human checkpoint.`);
    assert(resultManifest.workflow?.progress > 82, `${processorId} did not progress beyond 82% after exact authorization.`);
    assert(resultManifest.workflow?.processorAuthorizationState === "consumed", `${processorId} authority was not consumed.`);
    assert(resultManifest.processorAuthorizations?.[processorId]?.state === "consumed", `${processorId} manifest authority did not transition to consumed.`);
    assert(resultManifest.workflow?.processorResults?.[processorId]?.schema === "tmg.processor-result.v1", `${processorId} processor result was not written.`);
    assert(resultManifest.controls?.publicationAuthorized === false, `${processorId} unexpectedly granted publication authority.`);
    assert(resultManifest.controls?.externalProviderEgressAuthorized === false, `${processorId} unexpectedly granted provider egress.`);

    const titles = new Set((resultManifest.workflow?.events || []).map((entry) => entry.title));
    assert(titles.has("Processor-specific authority validated"), `${processorId} authority-consumption event missing.`);
    assert(titles.has(`${processorId} local adapter completed`), `${processorId} execution event missing.`);

    const customerResponse = await fetch(`https://tolanimediagroup.com/work-requests/${encodeURIComponent(requestId)}/status`, {
      headers: { accept: "application/json", "x-work-request-token": requestToken },
    });
    const customer = await customerResponse.json().catch(() => ({}));
    assert(customerResponse.ok, `${processorId} customer status returned HTTP ${customerResponse.status}: ${JSON.stringify(customer)}`);
    assert(customer.lifecycle?.progress === resultManifest.workflow.progress, `${processorId} customer progress does not match workflow progress.`);
    assert(customer.lifecycle?.progress > 82, `${processorId} customer view did not progress beyond 82%.`);
    assert(customer.context?.controls?.publicationAuthorized === false, `${processorId} customer view exposed publication authority.`);
    assert(customer.context?.controls?.externalProviderEgressAuthorized === false, `${processorId} customer view exposed provider egress authority.`);
    const customerTitles = new Set((customer.events || []).map((entry) => entry.title));
    assert(customerTitles.has("Processor-specific authority validated"), `${processorId} customer view is missing the authority event.`);
    assert(customerTitles.has(`${processorId} local adapter completed`), `${processorId} customer view is missing the processor completion event.`);

    const serializedCustomer = JSON.stringify(customer);
    assert(!serializedCustomer.includes(requestToken), `${processorId} customer view leaked request token.`);
    assert(!serializedCustomer.includes(tokenHash), `${processorId} customer view leaked token hash.`);
    assert(!serializedCustomer.includes(objectKey), `${processorId} customer view leaked R2 object key.`);
    assert(!serializedCustomer.includes(authorityId), `${processorId} customer view leaked internal authority ID.`);

    const describe = run(["workflows", "instances", "describe", workflow, instanceId, "--config", config, "--step-output=false"]);
    assert(/Completed|Success:\s+.*Yes/i.test(describe), `${processorId} workflow did not complete successfully after local adapter execution.`);

    const summary = {
      schema: "tmg.processor-authority-production-canary.v1",
      serviceType,
      processorId,
      requestId,
      instanceId,
      preAuthorizationProgress: 82,
      postAuthorizationProgress: resultManifest.workflow.progress,
      processorState: resultManifest.workflow.processorState,
      authorityState: resultManifest.processorAuthorizations[processorId].state,
      publicationAuthorized: resultManifest.controls.publicationAuthorized,
      externalProviderEgressAuthorized: resultManifest.controls.externalProviderEgressAuthorized,
      customerProgress: customer.lifecycle.progress,
    };
    succeeded = true;
    return summary;
  } finally {
    await cleanup();
    if (!succeeded) console.error(`${processorId} production canary failed; temporary R2 evidence was cleaned up.`);
  }
}

const mp4Fixture = Buffer.alloc(96);
mp4Fixture.writeUInt32BE(24, 0);
mp4Fixture.write("ftyp", 4, "ascii");
mp4Fixture.write("isom", 8, "ascii");
mp4Fixture.write("isom", 16, "ascii");

const cases = [
  {
    serviceType: "rights-provenance",
    processorId: "rights-provenance",
    allowedActions: ["validate_bound_evidence", "validate_rights_attestations", "record_structural_provenance"],
    fixtureName: "rights-evidence.txt",
    fixtureType: "text/plain",
    fixture: Buffer.from("TMG harmless rights/provenance structural verification canary\n", "utf8"),
  },
  {
    serviceType: "media-processing",
    processorId: "media-inspection",
    allowedActions: ["read_bound_media_header", "inspect_media_signature", "record_local_inspection"],
    fixtureName: "media-inspection-canary.mp4",
    fixtureType: "video/mp4",
    fixture: mp4Fixture,
  },
];

const results = [];
for (const item of cases) results.push(await executeCase(item));
console.log(JSON.stringify({ ok: true, schema: "tmg.processor-authority-production-suite.v1", results }, null, 2));
