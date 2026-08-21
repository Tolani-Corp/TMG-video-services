const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const indexName = process.env.TMG_ACCEPT_VECTOR_INDEX;

if (!accountId || !apiToken || !indexName) {
  console.error("missing Cloudflare account/token or TMG_ACCEPT_VECTOR_INDEX");
  process.exit(1);
}

const indexes = [
  ["tenantId", "string"],
  ["rightsVerified", "boolean"],
  ["publicationState", "string"],
  ["externalApi", "boolean"],
  ["mcp", "boolean"],
  ["advertising", "boolean"],
  ["datasetExport", "boolean"],
  ["licensing", "boolean"],
];

const base =
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/v2/indexes/${indexName}/metadata_index`;

function normalizeIndexType(value) {
  switch (value) {
    case "String":
    case "string":
      return "string";
    case "Bool":
    case "boolean":
      return "boolean";
    case "Number":
    case "number":
      return "number";
    default:
      return value;
  }
}

async function cf(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "authorization": `Bearer ${apiToken}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json();
  if (!response.ok || body.success !== true) {
    throw new Error(`Cloudflare API ${response.status}: ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.result;
}

async function list() {
  const result = await cf("/list");
  return new Map(
    (result.metadataIndexes ?? []).map((item) => [
      item.propertyName,
      normalizeIndexType(item.indexType),
    ]),
  );
}

let current = await list();
for (const [propertyName, indexType] of indexes) {
  const existing = current.get(propertyName);
  if (existing) {
    if (existing !== indexType) {
      throw new Error(`${propertyName} exists with type ${existing}; expected ${indexType}`);
    }
    continue;
  }
  const result = await cf("/create", {
    method: "POST",
    body: JSON.stringify({ propertyName, indexType }),
  });
  console.log(`enqueued metadata index ${propertyName}:${indexType} mutation=${result?.mutationId ?? "unknown"}`);
}

const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  current = await list();
  const complete = indexes.every(([name, type]) => current.get(name) === type);
  if (complete) {
    const evidence = {
      metadataIndexes: indexes.map(([propertyName, indexType]) => ({ propertyName, indexType })),
    };
    if (process.env.TMG_ACCEPT_METADATA_OUT) {
      const fs = await import("node:fs");
      fs.writeFileSync(process.env.TMG_ACCEPT_METADATA_OUT, JSON.stringify(evidence, null, 2) + "\n");
    }
    console.log(JSON.stringify(evidence));
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

throw new Error(
  `metadata indexes did not become ready: ${JSON.stringify([...current.entries()])}`,
);
