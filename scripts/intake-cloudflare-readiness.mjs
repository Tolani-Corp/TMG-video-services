import { writeFile } from "node:fs/promises";

const token = String(process.env.CLOUDFLARE_API_TOKEN || "").trim();
const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
const databaseName = String(process.env.TMG_CONTROL_DB_NAME || "tmg-video-control-dev").trim();
const zoneName = String(process.env.TMG_CONSOLE_ZONE || "tolanimediagroup.com").trim();
const consoleHost = String(process.env.TMG_CONSOLE_HOST || "console.tolanimediagroup.com").trim();
const API = "https://api.cloudflare.com/client/v4";

const REQUIRED_PERMISSIONS = [
  "Account / D1 Write",
  "Account / Access: Apps and Policies Write",
  "Account / Workers Scripts Write",
  "Zone / Zone Read (tolanimediagroup.com)",
  "Zone / Workers Routes Write (tolanimediagroup.com)",
];

class ReadinessError extends Error {
  constructor(stage, status, path, details = "") {
    super(`${stage} failed HTTP ${status}${details ? `: ${details}` : ""}`);
    this.name = "ReadinessError";
    this.stage = stage;
    this.status = status;
    this.path = path;
    this.details = details;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(token, "CLOUDFLARE_API_TOKEN is required");
assert(/^[0-9a-f]{32}$/i.test(accountId), "CLOUDFLARE_ACCOUNT_ID must be a 32-character account id");
assert(databaseName === "tmg-video-control-dev", "readiness gate is restricted to the development D1 database");
assert(zoneName === "tolanimediagroup.com", "readiness gate is restricted to tolanimediagroup.com");
assert(consoleHost === "console.tolanimediagroup.com", "readiness gate is restricted to console.tolanimediagroup.com");

function errorDetails(body) {
  if (!Array.isArray(body?.errors)) return "";
  return body.errors.map((entry) => entry?.message || entry?.code).filter(Boolean).join("; ");
}

async function readOnly(stage, path) {
  let lastStatus = 0;
  let lastBody = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(`${API}${path}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
    });
    lastStatus = response.status;
    const text = await response.text();
    try {
      lastBody = text ? JSON.parse(text) : null;
    } catch {
      lastBody = { raw: text };
    }

    if (response.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
      continue;
    }

    if (!response.ok || lastBody?.success === false) {
      throw new ReadinessError(stage, response.status, path, errorDetails(lastBody));
    }
    return lastBody;
  }
  throw new ReadinessError(stage, lastStatus, path, "rate limit persisted after bounded retries");
}

const evidence = {
  schema: "tmg.intake-cloudflare-readiness.v1",
  generatedAt: new Date().toISOString(),
  mode: "read_only",
  mutationAttempted: false,
  status: "HOLD",
  accountId,
  databaseName,
  zoneName,
  consoleHost,
  requiredPermissions: REQUIRED_PERMISSIONS,
  probes: {},
  discovered: {
    databaseId: null,
    zoneId: null,
    accessApplicationId: null,
    workerDomainId: null,
  },
  authority: {
    production: false,
    publicApi: false,
    mcp: false,
    ingestion: false,
    commercial: false,
  },
  failure: null,
};

async function persist() {
  await writeFile("intake-cloudflare-readiness.json", `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

async function probe(stage, path) {
  const response = await readOnly(stage, path);
  evidence.probes[stage] = { passed: true, path, httpStatus: 200 };
  return response;
}

try {
  const tokenResponse = await probe("token_verify", "/user/tokens/verify");
  const tokenStatus = tokenResponse?.result?.status || "unknown";
  if (tokenStatus !== "active") {
    throw new Error(`Cloudflare token must be active; current status is ${tokenStatus}`);
  }
  evidence.probes.token_verify.tokenStatus = tokenStatus;
  evidence.probes.token_verify.expiresOn = tokenResponse?.result?.expires_on || null;

  const d1 = await probe(
    "d1_list",
    `/accounts/${accountId}/d1/database?name=${encodeURIComponent(databaseName)}&per_page=100`,
  );
  const databases = (d1?.result || []).filter((row) => row?.name === databaseName);
  if (databases.length > 1) throw new Error(`multiple D1 databases named ${databaseName} exist`);
  evidence.discovered.databaseId = databases[0]?.uuid || null;
  evidence.probes.d1_list.resourceExists = databases.length === 1;

  const zones = await probe(
    "zone_read",
    `/zones?name=${encodeURIComponent(zoneName)}&account.id=${accountId}&per_page=50`,
  );
  const matchingZones = (zones?.result || []).filter(
    (zone) => zone?.name === zoneName && zone?.account?.id === accountId,
  );
  if (matchingZones.length !== 1) {
    throw new Error(`${zoneName} must resolve to exactly one zone in account ${accountId}`);
  }
  if (matchingZones[0]?.status !== "active") {
    throw new Error(`${zoneName} must be active; current status is ${matchingZones[0]?.status || "unknown"}`);
  }
  const zoneId = matchingZones[0].id;
  evidence.discovered.zoneId = zoneId;
  evidence.probes.zone_read.zoneStatus = matchingZones[0].status;

  const access = await probe(
    "access_apps_list",
    `/accounts/${accountId}/access/apps?per_page=100`,
  );
  const accessMatches = (access?.result || []).filter((app) => app?.domain === consoleHost);
  if (accessMatches.length > 1) throw new Error(`multiple Access applications protect ${consoleHost}`);
  evidence.discovered.accessApplicationId = accessMatches[0]?.id || null;
  evidence.probes.access_apps_list.resourceExists = accessMatches.length === 1;

  await probe("workers_scripts_list", `/accounts/${accountId}/workers/scripts`);

  const domains = await probe(
    "workers_domains_list",
    `/accounts/${accountId}/workers/domains?hostname=${encodeURIComponent(consoleHost)}`,
  );
  const domainMatches = (domains?.result || []).filter((domain) => domain?.hostname === consoleHost);
  if (domainMatches.length > 1) throw new Error(`multiple Worker Domains are attached to ${consoleHost}`);
  evidence.discovered.workerDomainId = domainMatches[0]?.id || null;
  evidence.probes.workers_domains_list.resourceExists = domainMatches.length === 1;
  evidence.probes.workers_domains_list.service = domainMatches[0]?.service || null;

  const routes = await probe("workers_routes_list", `/zones/${zoneId}/workers/routes`);
  const consoleRoutes = (routes?.result || []).filter((route) => String(route?.pattern || "").startsWith(`${consoleHost}/`));
  evidence.probes.workers_routes_list.consoleRouteCount = consoleRoutes.length;
  evidence.probes.workers_routes_list.consoleRoutes = consoleRoutes.map((route) => ({
    id: route?.id || null,
    pattern: route?.pattern || null,
    script: route?.script || null,
  }));

  evidence.status = "READY";
  await persist();
  console.log(JSON.stringify({
    schema: evidence.schema,
    status: evidence.status,
    mode: evidence.mode,
    mutationAttempted: false,
    tokenStatus: evidence.probes.token_verify.tokenStatus,
    databaseExists: evidence.probes.d1_list.resourceExists,
    zoneId: evidence.discovered.zoneId,
    accessAppExists: evidence.probes.access_apps_list.resourceExists,
    workerDomainExists: evidence.probes.workers_domains_list.resourceExists,
    consoleRouteCount: evidence.probes.workers_routes_list.consoleRouteCount,
  }));
} catch (error) {
  evidence.failure = {
    kind: error instanceof ReadinessError ? "cloudflare_api" : "validation",
    stage: error instanceof ReadinessError ? error.stage : "validation",
    httpStatus: error instanceof ReadinessError ? error.status : null,
    apiPath: error instanceof ReadinessError ? error.path : null,
    message: error instanceof Error ? error.message : "unknown_error",
  };
  await persist();
  console.error(JSON.stringify({
    schema: evidence.schema,
    status: evidence.status,
    mode: evidence.mode,
    mutationAttempted: false,
    failure: evidence.failure,
  }));
  process.exitCode = 1;
}
