import crypto from "node:crypto";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const indexName = process.env.TMG_ACCEPT_VECTOR_INDEX;
const expectedCount = Number(process.env.EXPECTED_COUNT ?? "0");
const maxAttempts = Number(process.env.MAX_ATTEMPTS ?? "40");

if (!accountId || !apiToken || !indexName) {
  console.error("missing Cloudflare account/token or TMG_ACCEPT_VECTOR_INDEX");
  process.exit(1);
}
if (!Number.isInteger(expectedCount) || expectedCount < 0) {
  throw new Error("EXPECTED_COUNT must be a nonnegative integer");
}

function byteToUnitFloat(byte) {
  return (byte - 127.5) / 127.5;
}

function digestBytes(value) {
  return crypto.createHash("sha256").update(value).digest();
}

function fixtureVector(dimensions = 512) {
  const seed = [
    "harmless_fixture_001",
    "s000",
    0,
    1000,
    "r2://tenants/tmg_fixture/assets/harmless_fixture_001/media/original.mp4",
  ].join("\u0000");

  const values = [];
  let counter = 0;
  while (values.length < dimensions) {
    const bytes = digestBytes(`${seed}\u0000${counter}`);
    for (const byte of bytes) {
      if (values.length >= dimensions) break;
      values.push(byteToUnitFloat(byte));
    }
    counter += 1;
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / norm);
}

async function query() {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/v2/indexes/${indexName}/query`,
    {
      method: "POST",
      headers: {
        "authorization": `Bearer ${apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        vector: fixtureVector(),
        topK: 10,
        namespace: "tmg_fixture",
        returnMetadata: "all",
        filter: {
          tenantId: "tmg_fixture",
          rightsVerified: true,
        },
      }),
    },
  );
  const body = await response.json();
  if (!response.ok || body.success !== true) {
    throw new Error(`Vectorize query ${response.status}: ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.result;
}

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const result = await query();
  const count = Number(result?.count ?? result?.matches?.length ?? 0);

  if (count === expectedCount) {
    if (expectedCount === 1) {
      const [match] = result.matches ?? [];
      if (!match) throw new Error("expected one match but result contained none");
      const metadata = match.metadata ?? {};
      const grants = ["externalApi", "mcp", "advertising", "datasetExport", "licensing"];
      if (metadata.publicationState !== "review") {
        throw new Error(`fixture publicationState must remain review; got ${metadata.publicationState}`);
      }
      if (metadata.rightsVerified !== true) {
        throw new Error("fixture rightsVerified metadata must be true before revocation");
      }
      for (const grant of grants) {
        if (metadata[grant] !== false) {
          throw new Error(`fixture commercial grant ${grant} must remain false`);
        }
      }
      if (metadata.assetId !== "harmless_fixture_001" || metadata.segmentId !== "s000") {
        throw new Error("unexpected fixture vector identity");
      }
    }

    const evidence = {
      expectedCount,
      observedCount: count,
      attempts: attempt,
      matches: result?.matches ?? [],
    };
    if (process.env.QUERY_OUT) {
      const fs = await import("node:fs");
      fs.writeFileSync(process.env.QUERY_OUT, JSON.stringify(evidence, null, 2) + "\n");
    }
    console.log(JSON.stringify(evidence));
    process.exit(0);
  }

  if (attempt < maxAttempts) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

throw new Error(`Vectorize did not reach expected count ${expectedCount}`);
