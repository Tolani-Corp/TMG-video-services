import crypto from "node:crypto";
import fs from "node:fs";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const outDir = process.env.TMG_RUNTIME_ACCEPTANCE_OUT ?? "production-runtime-acceptance";
const phase = process.argv.find((arg) => arg.startsWith("--phase="))?.split("=")[1] ?? "before";
const frozen = JSON.parse(fs.readFileSync("config/production-infrastructure-fingerprint.json", "utf8"));
const expectedWorker = "tmg-video-services-production";
const acceptanceWorker = "tmg-video-runtime-acceptance";
const expectedR2 = "tmg-video-assets-prod";
const expectedVector = "tmg-video-segments-512-prod";
const expectedWorkflows = ["tmg-video-ingestion-prod", "tmg-video-revocation-prod"];

if (!accountId || !apiToken) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
fs.mkdirSync(outDir, { recursive: true });

const request = async (pathname) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    method: "GET",
    headers: { authorization: `Bearer ${apiToken}`, accept: "application/json" },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success !== true) {
    throw new Error(`Cloudflare read failed ${response.status} ${pathname}: ${JSON.stringify(body.errors ?? body)}`);
  }
  return body;
};

const canonicalHash = (value) => crypto.createHash("sha256").update(`${JSON.stringify(value)}\n`).digest("hex");
const normalizeBinding = (binding) => {
  const result = { name: binding.name, type: binding.type };
  for (const key of ["bucket_name", "index_name", "namespace_id", "class_name", "workflow_name", "script_name", "text"]) {
    if (binding[key] !== undefined) result[key] = binding[key];
  }
  return result;
};

const listCursorArray = async (pathname, perPage = 1000) => {
  const items = [];
  let cursor = null;
  do {
    const separator = pathname.includes("?") ? "&" : "?";
    const cursorQuery = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const envelope = await request(`${pathname}${separator}per_page=${perPage}${cursorQuery}`);
    if (!Array.isArray(envelope.result)) throw new Error(`expected array result from ${pathname}`);
    items.push(...envelope.result);
    cursor = envelope.result_info?.cursor ?? null;
  } while (cursor);
  return items;
};

const listVectorIds = async () => {
  const ids = [];
  let cursor = null;
  do {
    const cursorQuery = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const envelope = await request(`/accounts/${accountId}/vectorize/v2/indexes/${expectedVector}/list?count=1000${cursorQuery}`);
    const result = envelope.result ?? {};
    ids.push(...(result.vectors ?? []).map((item) => item.id));
    cursor = result.isTruncated ? result.nextCursor ?? null : null;
    if (result.isTruncated && !cursor) throw new Error("Vectorize reported truncation without nextCursor");
  } while (cursor);
  return ids.sort();
};

const listZones = async () => {
  const zones = [];
  let page = 1;
  let totalPages = 1;
  do {
    const envelope = await request(`/zones?account.id=${encodeURIComponent(accountId)}&page=${page}&per_page=50`);
    zones.push(...(envelope.result ?? []));
    totalPages = envelope.result_info?.total_pages ?? 1;
    page += 1;
  } while (page <= totalPages);
  return zones;
};

const r2Bucket = (await request(`/accounts/${accountId}/r2/buckets/${expectedR2}`)).result;
const r2Objects = await listCursorArray(`/accounts/${accountId}/r2/buckets/${expectedR2}/objects`);
const r2ObjectManifest = r2Objects
  .map((item) => ({ key: item.key, size: item.size, etag: item.etag, uploaded: item.uploaded ?? item.last_modified ?? null }))
  .sort((a, b) => String(a.key).localeCompare(String(b.key)));

const vector = (await request(`/accounts/${accountId}/vectorize/v2/indexes/${expectedVector}`)).result;
const vectorInfo = (await request(`/accounts/${accountId}/vectorize/v2/indexes/${expectedVector}/info`)).result;
const vectorIds = await listVectorIds();
const metadataResult = (await request(`/accounts/${accountId}/vectorize/v2/indexes/${expectedVector}/metadata_index/list`)).result;
const metadataIndexes = (metadataResult?.metadataIndexes ?? [])
  .map((item) => ({ propertyName: item.propertyName, indexType: String(item.indexType).toLowerCase() }))
  .sort((a, b) => a.propertyName.localeCompare(b.propertyName));

const workerSettings = (await request(`/accounts/${accountId}/workers/scripts/${expectedWorker}/settings`)).result;
const workerSubdomain = (await request(`/accounts/${accountId}/workers/scripts/${expectedWorker}/subdomain`)).result;
const bindings = (workerSettings.bindings ?? []).map(normalizeBinding).sort((a, b) => a.name.localeCompare(b.name));
const expectedBindingNames = new Set((frozen.resources?.worker?.bindings ?? []).map((binding) => binding.name));
const governedBindings = bindings.filter((binding) => expectedBindingNames.has(binding.name));
const expectedRuntimeNames = Object.keys(frozen.resources?.worker?.runtimeFlags ?? {});
const runtimeFlags = Object.fromEntries(
  bindings.filter((binding) => expectedRuntimeNames.includes(binding.name)).map((binding) => [binding.name, binding.text]),
);

const namespaces = (await request(`/accounts/${accountId}/workers/durable_objects/namespaces?per_page=1000`)).result ?? [];
const ledgerNamespaces = namespaces.filter((item) => item.class === "TenantUsageLedger" && item.script === expectedWorker);
if (ledgerNamespaces.length !== 1) throw new Error(`expected one production TenantUsageLedger namespace, found ${ledgerNamespaces.length}`);

const workflows = {};
for (const workflowName of expectedWorkflows) {
  const definition = (await request(`/accounts/${accountId}/workflows/${workflowName}`)).result;
  const instances = await listCursorArray(`/accounts/${accountId}/workflows/${workflowName}/instances`, 100);
  workflows[workflowName] = {
    id: definition.id,
    className: definition.class_name,
    scriptName: definition.script_name,
    instances: instances
      .map((item) => ({ id: item.id, createdOn: item.created_on, status: item.status, triggerSource: item.trigger_source ?? null }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
  };
}

const domains = await listCursorArray(`/accounts/${accountId}/workers/domains`, 100);
const governedDomains = domains
  .filter((item) => [expectedWorker, acceptanceWorker].includes(item.service))
  .map((item) => ({ id: item.id, hostname: item.hostname, service: item.service, zoneId: item.zone_id }))
  .sort((a, b) => a.hostname.localeCompare(b.hostname));

const zones = await listZones();
const governedRoutes = [];
for (const zone of zones) {
  const envelope = await request(`/zones/${zone.id}/workers/routes`);
  for (const route of envelope.result ?? []) {
    if ([expectedWorker, acceptanceWorker].includes(route.script)) {
      governedRoutes.push({ zoneId: zone.id, zoneName: zone.name, id: route.id, pattern: route.pattern, script: route.script });
    }
  }
}
governedRoutes.sort((a, b) => `${a.zoneName}:${a.pattern}`.localeCompare(`${b.zoneName}:${b.pattern}`));

const scripts = await listCursorArray(`/accounts/${accountId}/workers/scripts`, 100);
const acceptanceScripts = scripts
  .filter((item) => item.id === acceptanceWorker || item.script_name === acceptanceWorker || item.service_name === acceptanceWorker)
  .map((item) => ({ id: item.id ?? item.script_name, modifiedOn: item.modified_on ?? null }));

const state = {
  schemaVersion: "1.0.0",
  cloudflareAccountId: accountId,
  productionWorker: {
    name: expectedWorker,
    compatibilityDate: workerSettings.compatibility_date ?? null,
    mainModule: workerSettings.main_module ?? null,
    bindings: governedBindings,
    runtimeFlags,
    workersDevEnabled: workerSubdomain.enabled === true,
    previewUrlsEnabled: workerSubdomain.previews_enabled === true,
  },
  r2: {
    name: r2Bucket.name ?? expectedR2,
    jurisdiction: r2Bucket.jurisdiction ?? null,
    storageClass: r2Bucket.storage_class ?? null,
    objectCount: r2ObjectManifest.length,
    objectManifestSha256: canonicalHash(r2ObjectManifest),
  },
  vectorize: {
    name: vector?.name ?? expectedVector,
    dimensions: vector?.config?.dimensions ?? vectorInfo?.dimensions ?? null,
    metric: vector?.config?.metric ?? null,
    vectorCount: vectorInfo?.vectorCount ?? vectorInfo?.vector_count ?? vectorIds.length,
    vectorIdsSha256: canonicalHash(vectorIds),
    processedUpToMutation: vectorInfo?.processedUpToMutation ?? vectorInfo?.processed_up_to_mutation ?? null,
    metadataIndexes,
  },
  workflows,
  durableObjectNamespace: {
    id: ledgerNamespaces[0].id,
    className: ledgerNamespaces[0].class,
    script: ledgerNamespaces[0].script,
    useSqlite: ledgerNamespaces[0].use_sqlite === true,
  },
  routing: {
    domains: governedDomains,
    routes: governedRoutes,
    acceptancePersistentScripts: acceptanceScripts,
  },
};

const frozenWorker = frozen.resources?.worker ?? {};
if (state.r2.name !== frozen.resources?.r2?.name) throw new Error("live R2 name does not match frozen fingerprint");
if (state.vectorize.dimensions !== frozen.resources?.vectorize?.dimensions || state.vectorize.metric !== frozen.resources?.vectorize?.metric) {
  throw new Error("live Vectorize dimensions/metric do not match frozen fingerprint");
}
if (JSON.stringify(state.vectorize.metadataIndexes) !== JSON.stringify(frozen.resources?.vectorize?.metadataIndexes ?? [])) {
  throw new Error("live Vectorize metadata indexes do not match frozen fingerprint");
}
if (JSON.stringify(state.productionWorker.bindings) !== JSON.stringify(frozenWorker.bindings ?? [])) {
  throw new Error("live production Worker resource bindings do not match frozen fingerprint");
}
if (JSON.stringify(state.productionWorker.runtimeFlags) !== JSON.stringify(frozenWorker.runtimeFlags ?? {})) {
  throw new Error("live production Worker runtime flags do not match frozen fingerprint");
}
if (state.productionWorker.workersDevEnabled || state.productionWorker.previewUrlsEnabled) {
  throw new Error("production Worker workers.dev or preview URLs are unexpectedly enabled");
}
if (state.durableObjectNamespace.id !== frozen.resources?.durableObjectNamespace?.id || !state.durableObjectNamespace.useSqlite) {
  throw new Error("live Durable Object namespace does not match frozen fingerprint");
}
if (state.routing.domains.length !== 0 || state.routing.routes.length !== 0) {
  throw new Error(`unexpected production/acceptance routing detected: ${JSON.stringify(state.routing)}`);
}
if (state.routing.acceptancePersistentScripts.length !== 0) {
  throw new Error(`persistent acceptance Worker script detected: ${JSON.stringify(state.routing.acceptancePersistentScripts)}`);
}

const surfaceSha256 = canonicalHash(state);
const output = { observedAt: new Date().toISOString(), phase, surfaceSha256, state };
fs.writeFileSync(`${outDir}/surface-${phase}.json`, `${JSON.stringify(output, null, 2)}\n`);
console.log(`production runtime surface ${phase} verified sha256=${surfaceSha256}`);
