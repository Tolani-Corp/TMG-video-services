# TMG Video Services

Governed, rights-aware multimodal video intelligence infrastructure for the Tolani ecosystem.

> **Current gate: G0 / internal prototype.** No public commercial API, MCP service, advertising product, dataset export, marketplace, or licensing capability is represented as live.

## v0.2 implementation

- typed video-segment, embedding-lineage, canonical asset-manifest, and rights-registry models;
- deny-by-default retrieval policy evaluation;
- separate grants for API, MCP, advertising, dataset export, and licensing;
- Cloudflare Vectorize retrieval with tenant/rights/publication pre-filtering;
- final rights checks for expiry and territory before matches are released;
- deterministic fixture-only temporal embedding provider;
- Cloudflare Workflow for durable fixture ingestion, disabled by default;
- private R2 control records for manifests, rights revisions, quarantine events, and index receipts;
- physical-evidence verification using R2 object size and SHA-256 evidence;
- revocation model that disables grants and deletes vector IDs recorded in index receipts;
- stateless MCP SDK v2 `search_video_moments`, disabled by default;
- REST vector-search route, disabled by default;
- Tolani commercial-context policy binding and G0 integrity CI;
- harmless synthetic MP4 fixture with committed SHA-256 and byte-count validation.

## Architecture

```text
Authorized / fixture video
     |
     v
Canonical asset manifest + rights revision
     |
     v
Private R2 physical evidence
     |
     v
Durable ingestion Workflow
     |
     +--> quarantine on missing/mismatched evidence
     |
     v
Temporal segments + embedding lineage
     |
     +--------------------+
     |                    |
     v                    v
R2 control records   Vectorize index
                          |
                          v
                 rights-aware retrieval
                    /             \
                   v               v
              REST API          MCP gateway
              disabled          disabled
                at G0             at G0
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/SECURITY_AND_RIGHTS.md`](docs/SECURITY_AND_RIGHTS.md), and [`docs/INGESTION_PLANE.md`](docs/INGESTION_PLANE.md).

## Ecosystem governance

This repository inherits the Tolani Commercial Context Plane from `Tolani-Corp/TolaniCorp-HQ`.

**Semantic similarity is never authorization.** A vector match may only be released when policy permits the tenant, territory, publication state, rights-evidence state, and requested purpose.

Local policy files:

- `config/public-product-context.json`
- `config/ecosystem-policy-binding.json`
- `config/retrieval-policy.json`

## Development

Prerequisites: Node.js 22+ and pnpm.

```bash
pnpm install
pnpm cf-typegen
pnpm check
pnpm dev
```

`wrangler types` generates `worker-configuration.d.ts`; that generated file is intentionally not committed so Worker binding types remain derived from `wrangler.jsonc`.

## Development resource provisioning

The Worker configuration names development resources but does not assert they are provisioned. Create them before exercising retrieval or ingestion:

```bash
npx wrangler@latest r2 bucket create tmg-video-assets-dev
npx wrangler@latest vectorize create tmg-video-segments-512-dev --dimensions=512 --metric=cosine
```

Create metadata indexes **before inserting vectors**:

```bash
npx wrangler@latest vectorize create-metadata-index tmg-video-segments-512-dev --property-name=tenantId --type=string
npx wrangler@latest vectorize create-metadata-index tmg-video-segments-512-dev --property-name=rightsVerified --type=boolean
npx wrangler@latest vectorize create-metadata-index tmg-video-segments-512-dev --property-name=publicationState --type=string
npx wrangler@latest vectorize create-metadata-index tmg-video-segments-512-dev --property-name=externalApi --type=boolean
npx wrangler@latest vectorize create-metadata-index tmg-video-segments-512-dev --property-name=mcp --type=boolean
npx wrangler@latest vectorize create-metadata-index tmg-video-segments-512-dev --property-name=advertising --type=boolean
npx wrangler@latest vectorize create-metadata-index tmg-video-segments-512-dev --property-name=datasetExport --type=boolean
npx wrangler@latest vectorize create-metadata-index tmg-video-segments-512-dev --property-name=licensing --type=boolean
```

## Harmless fixture acceptance

The fixture lane exists only to prove ingestion mechanics without third-party media or commercialization authority.

```bash
pnpm fixture:verify

pnpm wrangler r2 object put \
  tmg-video-assets-dev/tenants/tmg_fixture/assets/harmless_fixture_001/media/original.mp4 \
  --file fixtures/harmless/harmless-fixture.mp4 \
  --content-type video/mp4 \
  --remote
```

Then follow `docs/INGESTION_PLANE.md` to enable the development Workflow temporarily, trigger it with `fixtures/harmless/control.json`, inspect the R2 receipt/Vectorize records, and disable ingestion again. Public REST and MCP flags remain independent and must stay false at G0.

## Safe activation sequence

1. pass tests, fixture-integrity validation, and policy integrity;
2. merge the HoldCo G0 registry update;
3. provision isolated development R2, Vectorize, and Workflow resources;
4. execute harmless fixture ingestion and revocation acceptance tests;
5. add the first external embedding-provider adapter behind explicit egress/secret/retention controls;
6. add tenant authentication, quotas, billing-meter events, and abuse controls;
7. obtain G1/G2 commercial-context promotion evidence before enabling any external surface.

## Commercial direction

Enterprise video RAG, developer APIs, MCP access, contextual advertising signals, rights/provenance services, agentic licensing, and rights-cleared dataset packaging are future product surfaces over this shared core. Each remains future capability until independently approved by Tolani commercial-context and rights gates.
