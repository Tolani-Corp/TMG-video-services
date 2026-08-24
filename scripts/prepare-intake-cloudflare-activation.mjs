import { appendFile, writeFile } from "node:fs/promises";

const token = String(process.env.CLOUDFLARE_API_TOKEN || "").trim();
const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
const databaseName = String(process.env.TMG_CONTROL_DB_NAME || "tmg-video-control-dev").trim();
const zoneName = String(process.env.TMG_CONSOLE_ZONE || "tolanimediagroup.com").trim();
const consoleHost = String(process.env.TMG_CONSOLE_HOST || "console.tolanimediagroup.com").trim();
const appName = "TMG Internal Console";
const policyName = "TMG Cloudflare account members";
const API = "https://api.cloudflare.com/client/v4";

class CloudflareApiError extends Error {
  constructor(method, path, status, details = "") {
    super(`Cloudflare API ${method} ${path} failed HTTP ${status}${details ? `: ${details}` : ""}`);
    this.name = "CloudflareApiError";
    this.method = method;
    this.path = path;
    this.status = status;
    this.details = details;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sanitizedFailure(error, stage) {
  return {
    stage,
    kind: error instanceof CloudflareApiError ? "cloudflare_api" : "validation",
    message: error instanceof Error ? error.message : "unknown_error",
    httpStatus: error instanceof CloudflareApiError ? error.status : null,
    method: error instanceof CloudflareApiError ? error.method : null,
    apiPath: error instanceof CloudflareApiError ? error.path : null,
  };
}

async function writeEvidence(evidence) {
  await writeFile("intake-cloudflare-preparation.json", `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

assert(token, "CLOUDFLARE_API_TOKEN is required");
assert(/^[0-9a-f]{32}$/i.test(accountId), "CLOUDFLARE_ACCOUNT_ID must be a 32-character account id");
assert(databaseName === "tmg-video-control-dev", "only the development D1 control database may be provisioned");
assert(zoneName === "tolanimediagroup.com", "only the tolanimediagroup.com zone is authorized");
assert(consoleHost === "console.tolanimediagroup.com", "only console.tolanimediagroup.com may be activated");

async function cloudflare(path, init = {}) {
  let lastStatus = 0;
  let lastBody = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });
    lastStatus = response.status;
    const text = await response.text();
    try { lastBody = text ? JSON.parse(text) : null; } catch { lastBody = { raw: text }; }
    if (response.status !== 429) {
      if (!response.ok || lastBody?.success === false) {
        const details = Array.isArray(lastBody?.errors)
          ? lastBody.errors.map((entry) => entry?.message || entry?.code).filter(Boolean).join("; ")
          : "";
        throw new CloudflareApiError(init.method || "GET", path, response.status, details);
      }
      return lastBody;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
  }
  throw new CloudflareApiError(init.method || "GET", path, lastStatus, "rate limit persisted after bounded retries");
}

async function verifyToken() {
  const response = await cloudflare("/user/tokens/verify");
  const status = response?.result?.status || "unknown";
  assert(status === "active", `Cloudflare API token status must be active, got ${status}`);
  return {
    id: response?.result?.id || null,
    status,
    expiresOn: response?.result?.expires_on || null,
    notBefore: response?.result?.not_before || null,
  };
}

async function ensureD1() {
  const listed = await cloudflare(`/accounts/${accountId}/d1/database?name=${encodeURIComponent(databaseName)}&per_page=100`);
  const matches = (listed?.result || []).filter((row) => row?.name === databaseName);
  assert(matches.length <= 1, `multiple D1 databases named ${databaseName} exist`);
  if (matches.length === 1) {
    return { id: matches[0].uuid, created: false };
  }

  const created = await cloudflare(`/accounts/${accountId}/d1/database`, {
    method: "POST",
    body: JSON.stringify({
      name: databaseName,
      primary_location_hint: "enam",
      read_replication: { mode: "disabled" },
    }),
  });
  assert(created?.result?.uuid, "Cloudflare did not return a D1 UUID");
  return { id: created.result.uuid, created: true };
}

async function requireZone() {
  const response = await cloudflare(`/zones?name=${encodeURIComponent(zoneName)}&account.id=${accountId}&per_page=50`);
  const matches = (response?.result || []).filter((zone) => zone?.name === zoneName && zone?.account?.id === accountId);
  assert(matches.length === 1, `${zoneName} must resolve to exactly one active zone in the target account`);
  assert(matches[0]?.status === "active", `${zoneName} must be active before console activation`);
  return { id: matches[0].id, status: matches[0].status };
}

function policyAllowsOnlyAccountMembers(policy) {
  if (policy?.name !== policyName || policy?.decision !== "allow") return false;
  const include = Array.isArray(policy?.include) ? policy.include : [];
  return include.length === 1 && include[0]?.cloudflare_account_member?.account_id === accountId;
}

async function ensureAccessApp() {
  const listed = await cloudflare(`/accounts/${accountId}/access/apps?per_page=100`);
  const matches = (listed?.result || []).filter((app) => app?.domain === consoleHost);
  assert(matches.length <= 1, `multiple Access applications protect ${consoleHost}`);

  let app = matches[0];
  let created = false;
  if (!app) {
    const response = await cloudflare(`/accounts/${accountId}/access/apps`, {
      method: "POST",
      body: JSON.stringify({
        name: appName,
        type: "self_hosted",
        domain: consoleHost,
        session_duration: "8h",
        app_launcher_visible: false,
        allow_authenticate_via_warp: false,
      }),
    });
    app = response?.result;
    created = true;
  }

  assert(app?.id, "Access application id is missing");
  assert(app?.type === "self_hosted", "existing console Access application is not self_hosted");
  assert(app?.domain === consoleHost, "Access application domain drifted");

  const policiesResponse = await cloudflare(`/accounts/${accountId}/access/apps/${app.id}/policies?per_page=100`);
  const policies = policiesResponse?.result || [];
  const unexpected = policies.filter((policy) => policy?.name !== policyName);
  assert(unexpected.length === 0, `unexpected Access policies already protect ${consoleHost}: ${unexpected.map((p) => p?.name || p?.id).join(", ")}`);

  let policy = policies.find((entry) => entry?.name === policyName);
  let policyCreated = false;
  if (!policy) {
    const response = await cloudflare(`/accounts/${accountId}/access/apps/${app.id}/policies`, {
      method: "POST",
      body: JSON.stringify({
        name: policyName,
        precedence: 1,
        decision: "allow",
        include: [{ cloudflare_account_member: { account_id: accountId } }],
      }),
    });
    policy = response?.result;
    policyCreated = true;
  }

  assert(policy?.id, "Access policy id is missing");
  assert(policyAllowsOnlyAccountMembers(policy), "console Access policy is broader than Cloudflare account members");
  return { app, policy, created, policyCreated };
}

const evidence = {
  schema: "tmg.intake-cloudflare-preparation.v1.1",
  generatedAt: new Date().toISOString(),
  status: "HOLD",
  tokenVerification: null,
  database: { name: databaseName, id: null, createdThisRun: false },
  zone: { name: zoneName, id: null, status: "unverified" },
  access: {
    domain: consoleHost,
    applicationId: null,
    policyId: null,
    allowedPopulation: "cloudflare-account-members-only",
    status: "unverified",
  },
  consoleHost,
  accessCreatedBeforeDomainAttachment: false,
  customDomainAttached: false,
  workerDeployed: false,
  productionAuthority: false,
  requiredTokenPermissions: [
    "Account / D1 Write",
    "Account / Access: Apps and Policies Write",
    "Account / Workers Scripts Write",
    "Zone / Zone Read (tolanimediagroup.com)",
    "Zone / Workers Routes Write (tolanimediagroup.com)",
  ],
  failure: null,
};

let stage = "token_verify";
try {
  evidence.tokenVerification = await verifyToken();

  stage = "d1";
  const database = await ensureD1();
  evidence.database = {
    name: databaseName,
    id: database.id,
    createdThisRun: database.created,
    primaryLocationHint: "enam",
    readReplication: "disabled",
  };

  stage = "zone";
  const zone = await requireZone();
  evidence.zone = { name: zoneName, id: zone.id, status: zone.status };

  stage = "access";
  const access = await ensureAccessApp();
  evidence.access = {
    applicationId: access.app.id,
    applicationName: access.app.name,
    applicationType: access.app.type,
    domain: access.app.domain,
    createdThisRun: access.created,
    policyId: access.policy.id,
    policyName: access.policy.name,
    policyCreatedThisRun: access.policyCreated,
    decision: access.policy.decision,
    allowedPopulation: "cloudflare-account-members-only",
    status: "prepared",
  };
  evidence.accessCreatedBeforeDomainAttachment = true;
  evidence.status = "PREPARED";

  await writeEvidence(evidence);

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, [
      `database_id=${database.id}`,
      `zone_id=${zone.id}`,
      `access_app_id=${access.app.id}`,
      `access_policy_id=${access.policy.id}`,
      "",
    ].join("\n"));
  }

  console.log(JSON.stringify({
    schema: evidence.schema,
    status: evidence.status,
    tokenStatus: evidence.tokenVerification.status,
    databaseId: database.id,
    databaseCreated: database.created,
    zoneId: zone.id,
    accessAppId: access.app.id,
    accessPolicyId: access.policy.id,
    accessCreatedBeforeDomainAttachment: true,
    productionAuthority: false,
  }));
} catch (error) {
  evidence.failure = sanitizedFailure(error, stage);
  await writeEvidence(evidence);
  console.error(JSON.stringify({
    schema: evidence.schema,
    status: evidence.status,
    stage,
    failure: evidence.failure,
    productionAuthority: false,
  }));
  throw error;
}
