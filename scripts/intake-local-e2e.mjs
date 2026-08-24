import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const PORT = Number(process.env.TMG_INTAKE_E2E_PORT || 8799);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const RUN_ID = `${process.pid}-${Date.now()}`;
const STATE_DIR = path.join(ROOT, ".wrangler", `intake-e2e-${RUN_ID}`);
const CONFIG_PATH = path.join(ROOT, `.wrangler.intake-e2e-${RUN_ID}.jsonc`);
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const SUBMITTER = "submitter.synthetic@tmg.local";
const REVIEWER = "reviewer.synthetic@tmg.local";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function localConfig(identityEmail) {
  const config = {
    name: "tmg-video-intake-api-local-e2e",
    main: "src/intake-api-worker.ts",
    compatibility_date: "2026-08-24",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    vars: {
      TMG_PUBLIC_API_ENABLED: "false",
      TMG_MCP_ENABLED: "false",
      TMG_INGEST_WORKFLOW_ENABLED: "false",
      TMG_INGESTION_MODE: "fixture_only",
      TMG_POLICY_VERSION: "2026-08-20.v3",
      TMG_EMBEDDING_DIMENSIONS: "512",
      TMG_EMBEDDING_PROVIDER_ID: "fixture",
      TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED: "false",
      TMG_PROVIDER_ACCEPTANCE_STATE: "unverified",
      TMG_TENANT_USAGE_LEDGER_ENABLED: "false",
      TMG_INTAKE_ENABLED: "true",
      TMG_CONTROL_DB_BINDING_STATE: "provisioned",
      TMG_CONSOLE_HOST: "console.tolanimediagroup.com",
    },
    d1_databases: [
      {
        binding: "CONTROL_DB",
        database_name: "tmg-video-control-local",
        database_id: "11111111-1111-1111-1111-111111111111",
        migrations_dir: "migrations",
      },
    ],
    r2_buckets: [
      {
        binding: "MEDIA_BUCKET",
        bucket_name: "tmg-video-assets-local",
      },
    ],
    observability: { enabled: false },
  };

  if (identityEmail) {
    config.access = {
      dev: {
        aud: "tmg-intake-local-e2e",
        identity: {
          email: identityEmail,
          name: identityEmail === SUBMITTER ? "Synthetic Submitter" : "Synthetic Reviewer",
        },
      },
    };
  }

  return `${JSON.stringify(config, null, 2)}\n`;
}

async function runWrangler(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(PNPM, ["exec", "wrangler", ...args], {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wrangler ${args.join(" ")} failed with ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function waitForServer(child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited before becoming ready: ${child.exitCode}`);
    try {
      const response = await fetch(`${BASE_URL}/v1/console/session`, { redirect: "manual" });
      if (response.status > 0) return;
    } catch {
      // Dev server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("wrangler dev did not become ready within 30 seconds");
}

async function startServer(identityEmail) {
  await writeFile(CONFIG_PATH, localConfig(identityEmail), "utf8");
  const child = spawn(
    PNPM,
    [
      "exec",
      "wrangler",
      "dev",
      "--config",
      CONFIG_PATH,
      "--ip",
      "127.0.0.1",
      "--port",
      String(PORT),
      "--persist-to",
      STATE_DIR,
    ],
    {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => {
    if (process.env.TMG_INTAKE_E2E_VERBOSE === "1") process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    if (process.env.TMG_INTAKE_E2E_VERBOSE === "1") process.stderr.write(chunk);
  });
  await waitForServer(child);
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function jsonRequest(method, pathname, body) {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const headers = { accept: "application/json" };
  if (raw !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(raw));
  }
  const response = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers,
    body: raw,
    redirect: "manual",
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  return { response, data };
}

async function upload(pathname, buffer, mimeType, digest) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    method: "PUT",
    headers: {
      accept: "application/json",
      "content-type": mimeType,
      "content-length": String(buffer.byteLength),
      "x-tmg-content-sha256": digest,
    },
    body: buffer,
    redirect: "manual",
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  return { response, data };
}

async function readSyntheticSource() {
  const candidates = [
    "fixtures/external-eval/jina/tmg-jina-eval-fixture.mp4",
    "fixtures/harmless/harmless-fixture.mp4",
  ];
  for (const relative of candidates) {
    try {
      return { relative, bytes: await readFile(path.join(ROOT, relative)) };
    } catch {
      // Try the next repo-owned synthetic fixture.
    }
  }
  throw new Error("no repo-owned synthetic video fixture is available for intake acceptance");
}

async function main() {
  let server;
  try {
    await writeFile(CONFIG_PATH, localConfig(SUBMITTER), "utf8");
    await runWrangler([
      "d1",
      "migrations",
      "apply",
      "tmg-video-control-local",
      "--local",
      "--persist-to",
      STATE_DIR,
      "--config",
      CONFIG_PATH,
    ]);

    const source = await readSyntheticSource();
    const sourceSha = sha256(source.bytes);
    const rightsBytes = Buffer.from(JSON.stringify({
      schemaVersion: "tmg.synthetic-rights-evidence.v1",
      testRunId: RUN_ID,
      source: source.relative,
      owner: "Tolani-Corp",
      synthetic: true,
      grant: "internal-processing-evaluation-only",
      publication: false,
      commercialUse: false,
      productionAuthority: false,
    }, null, 2));
    const rightsSha = sha256(rightsBytes);

    server = await startServer(SUBMITTER);
    let result = await jsonRequest("GET", "/v1/console/session");
    assert(result.response.status === 200, `submitter session expected 200, got ${result.response.status}`);
    assert(result.data?.actor?.email === SUBMITTER, "submitter Access identity was not projected correctly");
    assert(result.data?.intake?.processingAuthority === false, "session must not grant processing authority");

    result = await jsonRequest("POST", "/v1/intake/requests", {
      requestName: "Local rights-first synthetic acceptance",
      audience: "Internal evaluator",
      businessGoal: "Prove authenticated rights-first intake without production authority.",
      priority: "standard",
      deliverables: ["searchable-package"],
      outputFormat: "16:9 landscape",
      targetDuration: "< 15 sec",
      notes: `local-e2e:${RUN_ID}`,
    });
    assert(result.response.status === 201, `request creation expected 201, got ${result.response.status}`);
    const requestId = result.data?.request?.requestId;
    assert(typeof requestId === "string", "request id missing from create response");
    assert(result.data?.request?.authority?.processing === false, "request must not grant processing authority");

    result = await jsonRequest("POST", `/v1/intake/requests/${encodeURIComponent(requestId)}/assets`, {
      filename: path.basename(source.relative),
      mimeType: "video/mp4",
      expectedBytes: source.bytes.byteLength,
      expectedSha256: sourceSha,
    });
    assert(result.response.status === 201, `asset registration expected 201, got ${result.response.status}`);
    const assetId = result.data?.asset?.assetId;
    assert(typeof assetId === "string", "asset id missing from register response");
    assert(result.data?.asset?.processable === false, "registered asset must be non-processable");

    result = await jsonRequest("POST", `/v1/intake/assets/${encodeURIComponent(assetId)}/rights`, {
      evidenceKind: "synthetic_repo_owned",
      description: "Repo-owned synthetic acceptance evidence granting internal processing evaluation only.",
      filename: "synthetic-rights-evidence.json",
      mimeType: "application/json",
      expectedBytes: rightsBytes.byteLength,
      expectedSha256: rightsSha,
      grantsInternalProcessing: true,
      grantsDerivativeUse: false,
      grantsExternalProviderEvaluation: false,
    });
    assert(result.response.status === 201, `rights registration expected 201, got ${result.response.status}`);
    const evidenceId = result.data?.rightsEvidence?.evidenceId;
    assert(typeof evidenceId === "string", "rights evidence id missing");

    result = await upload(
      `/v1/intake/rights/${encodeURIComponent(evidenceId)}/evidence`,
      rightsBytes,
      "application/json",
      rightsSha,
    );
    assert(result.response.status === 201, `rights evidence upload expected 201, got ${result.response.status}`);
    assert(result.data?.rightsEvidence?.uploadState === "integrity_verified", "rights evidence did not reach integrity_verified");

    result = await upload(
      `/v1/intake/assets/${encodeURIComponent(assetId)}/quarantine`,
      source.bytes,
      "video/mp4",
      sourceSha,
    );
    assert(result.response.status === 403, "source upload before independent rights review must be denied");

    result = await jsonRequest("POST", `/v1/intake/rights/${encodeURIComponent(evidenceId)}/review`, {
      decision: "verify",
      rationale: "Self-review should be rejected by the server.",
    });
    assert(result.response.status === 403, "submitter must not be able to approve their own rights evidence");
    await stopServer(server);
    server = undefined;

    server = await startServer(REVIEWER);
    result = await jsonRequest("GET", "/v1/console/session");
    assert(result.response.status === 200, `reviewer session expected 200, got ${result.response.status}`);
    assert(result.data?.actor?.email === REVIEWER, "reviewer Access identity was not projected correctly");

    result = await jsonRequest("GET", "/v1/intake/rights/review-queue");
    assert(result.response.status === 200, `review queue expected 200, got ${result.response.status}`);
    assert(
      Array.isArray(result.data?.rightsEvidence) && result.data.rightsEvidence.some((row) => row.evidenceId === evidenceId),
      "independent reviewer could not see integrity-verified evidence",
    );

    const evidenceResponse = await fetch(
      `${BASE_URL}/v1/intake/rights/${encodeURIComponent(evidenceId)}/evidence-file`,
      { redirect: "manual" },
    );
    assert(evidenceResponse.status === 200, `evidence download expected 200, got ${evidenceResponse.status}`);
    const downloadedEvidence = Buffer.from(await evidenceResponse.arrayBuffer());
    assert(downloadedEvidence.byteLength === rightsBytes.byteLength, "reviewed evidence byte length drifted");
    assert(sha256(downloadedEvidence) === rightsSha, "reviewed evidence SHA-256 drifted");

    result = await jsonRequest("POST", `/v1/intake/rights/${encodeURIComponent(evidenceId)}/review`, {
      decision: "verify",
      rationale: "Synthetic repo-owned rights evidence independently reviewed for local acceptance.",
    });
    assert(result.response.status === 200, `independent rights review expected 200, got ${result.response.status}`);
    assert(result.data?.rightsEvidence?.reviewState === "verified", "rights evidence did not become verified");
    assert(result.data?.rightsEvidence?.verifiedBy === REVIEWER, "rights reviewer identity was not recorded");
    await stopServer(server);
    server = undefined;

    server = await startServer(SUBMITTER);
    result = await upload(
      `/v1/intake/assets/${encodeURIComponent(assetId)}/quarantine`,
      source.bytes,
      "video/mp4",
      sourceSha,
    );
    assert(result.response.status === 201, `post-rights source quarantine expected 201, got ${result.response.status}`);
    assert(result.data?.asset?.rightsState === "verified", "quarantined source must retain verified rights state");
    assert(result.data?.asset?.uploadState === "quarantined_integrity_verified", "source did not reach integrity-verified quarantine");
    assert(result.data?.asset?.processable === false, "quarantined source must remain non-processable at G0");
    assert(result.data?.processingAuthority === false, "source quarantine response must deny processing authority");

    result = await jsonRequest("POST", `/v1/intake/requests/${encodeURIComponent(requestId)}/jobs`, {
      acknowledgement: "processing-authority-remains-blocked-at-g0",
    });
    assert(result.response.status === 201, `blocked job creation expected 201, got ${result.response.status}`);
    assert(result.data?.job?.status === "blocked_processing_authority", "job must remain processing blocked");
    assert(result.data?.job?.processingAuthority === false, "job must not gain processing authority");
    assert(result.data?.job?.billable === false, "job must remain non-billable at G0");
    assert(result.data?.workflowDispatched === false, "G0 job creation must not dispatch a Workflow");

    result = await jsonRequest("GET", `/v1/intake/requests/${encodeURIComponent(requestId)}`);
    assert(result.response.status === 200, `request bundle expected 200, got ${result.response.status}`);
    assert(result.data?.request?.status === "ready_for_operator_review", "request should stop at ready_for_operator_review");
    assert(result.data?.request?.authority?.processing === false, "request bundle must retain processing=false");
    assert(result.data?.rightsEvidence?.[0]?.submittedBy === SUBMITTER, "rights submitter identity drifted");
    assert(result.data?.rightsEvidence?.[0]?.verifiedBy === REVIEWER, "independent reviewer identity drifted");
    await stopServer(server);
    server = undefined;

    server = await startServer(null);
    result = await jsonRequest("GET", "/v1/console/session");
    assert(result.response.status === 403, `unauthenticated session expected 403, got ${result.response.status}`);
    assert(result.data?.error === "access_required", "unauthenticated denial must be Access-derived");
    await stopServer(server);
    server = undefined;

    console.log(JSON.stringify({
      schema: "tmg.intake-local-e2e.v1",
      status: "PASS",
      runId: RUN_ID,
      identities: { submitter: SUBMITTER, reviewer: REVIEWER },
      requestId,
      assetId,
      evidenceId,
      rightsFirst: true,
      selfReviewDenied: true,
      preRightsSourceUploadDenied: true,
      sourceQuarantinedAfterRights: true,
      processingAuthority: false,
      workflowDispatched: false,
      billable: false,
      unauthenticatedDenied: true,
    }));
  } finally {
    await stopServer(server).catch(() => {});
    if (process.env.TMG_KEEP_LOCAL_E2E !== "1") {
      await Promise.all([
        rm(CONFIG_PATH, { force: true }).catch(() => {}),
        rm(STATE_DIR, { recursive: true, force: true }).catch(() => {}),
      ]);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
