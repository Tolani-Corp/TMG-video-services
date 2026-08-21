const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const indexName = process.env.TMG_MARENGO_SHADOW_INDEX;

if (!accountId || !apiToken || !indexName) {
  console.error("missing Cloudflare account/token or TMG_MARENGO_SHADOW_INDEX");
  process.exit(1);
}

const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/v2/indexes`;

async function readBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

async function cf(path, init = {}, { allow404 = false } = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await readBody(response);
  if (allow404 && response.status === 404) return null;
  if (!response.ok || body?.success !== true) {
    throw new Error(`Cloudflare Vectorize HTTP ${response.status}: ${JSON.stringify(body?.errors ?? body)}`);
  }
  return body.result;
}

let index = await cf(`/${encodeURIComponent(indexName)}`, {}, { allow404: true });
if (!index) {
  index = await cf("", {
    method: "POST",
    body: JSON.stringify({
      name: indexName,
      description: "TMG governed Marengo 3.0 development shadow evaluation index",
      config: { dimensions: 512, metric: "cosine" },
    }),
  });
  console.log(`created Vectorize index ${indexName}`);
} else {
  console.log(`Vectorize index ${indexName} already exists`);
}

const dimensions = index?.config?.dimensions;
const metric = index?.config?.metric;
if (dimensions !== 512 || metric !== "cosine") {
  throw new Error(
    `Shadow index contract mismatch: dimensions=${String(dimensions)} metric=${String(metric)}`,
  );
}

if (process.env.GITHUB_ENV) {
  const fs = await import("node:fs");
  fs.appendFileSync(process.env.GITHUB_ENV, `TMG_ACCEPT_VECTOR_INDEX=${indexName}\n`);
}

console.log(JSON.stringify({ indexName, dimensions, metric, state: "ready" }));
