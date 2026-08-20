# TMG Video Services

Governed, rights-aware multimodal video intelligence infrastructure for the Tolani ecosystem.

> **Current gate: G0 / internal prototype.** No public commercial API, MCP service, advertising product, dataset export, marketplace, or licensing capability is represented as live.

## v1 implementation

- typed video-segment, embedding-lineage, and rights models;
- deny-by-default retrieval policy evaluation;
- separate grants for API, MCP, advertising, dataset export, and licensing;
- Cloudflare Vectorize retrieval with tenant/rights/publication pre-filtering;
- final rights checks for expiry and territory before matches are released;
- stateless MCP SDK v2 `search_video_moments`, disabled by default;
- REST vector-search route, disabled by default;
- R2 and Vectorize development bindings;
- Tolani commercial-context policy binding and G0 integrity CI;
- unit tests for policy and vector-filter behavior.

## Architecture

```text
Authorized video
     |
     v
Provenance + canonical rights evidence
     |
     v
Temporal segments + embedding lineage
     |
     +--------------------+
     |                    |
     v                    v
R2 artifacts         Vectorize index
                          |
                          v
                 rights-aware retrieval
                    /             \
                   v               v
              REST API          MCP gateway
              disabled          disabled
                at G0             at G0
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/SECURITY_AND_RIGHTS.md`](docs/SECURITY_AND_RIGHTS.md).

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

The Worker configuration names development resources but does not assert they are provisioned. Create them before exercising retrieval:

```bash
npx wrangler@latest r2 bucket create tmg-video-assets-dev
npx wrangler@latest vectorize create tmg-video-segments-512-dev --dimensions=512 --metric=cosine
```

Create metadata indexes **before inserting vectors**:

```bash
npx wrangler@latest vectorize create-metadata-index tmg-video-segments-512-dev --propertyName=tenantId --type=string
npx wrangler@latest vectorize create-metadata-index tmg-video-segments-512-dev --propertyName=rightsVerified --type=boolean
npx wrangler@latest vectorize create-metadata-index tmg-video-segments-512-dev --propertyName=publicationState --type=string
npx wrangler@latest vectorize create-metadata-index tmg-video-segments-512-dev --propertyName=externalApi --type=boolean
npx wrangler@latest vectorize create-metadata-index tmg-video-segments-512-dev --propertyName=mcp --type=boolean
npx wrangler@latest vectorize create-metadata-index tmg-video-segments-512-dev --propertyName=advertising --type=boolean
npx wrangler@latest vectorize create-metadata-index tmg-video-segments-512-dev --propertyName=datasetExport --type=boolean
npx wrangler@latest vectorize create-metadata-index tmg-video-segments-512-dev --propertyName=licensing --type=boolean
```

## Safe activation sequence

Do not flip either enablement flag merely to test production connectivity. Promotion order is:

1. pass tests and policy integrity;
2. register the repository in the canonical Tolani portfolio registry;
3. implement canonical asset/rights persistence plus revocation propagation;
4. add authenticated ingestion and embedding-provider adapters;
5. add API/MCP authentication, tenant authorization, quotas, and abuse controls;
6. provision isolated staging resources and harmless fixtures;
7. run staging retrieval, isolation, expiry, and revocation tests;
8. obtain ecosystem gate promotion and release evidence;
9. enable only the approved surface.

## Commercial direction

Enterprise video RAG, developer APIs, MCP access, contextual advertising signals, rights/provenance services, agentic licensing, and rights-cleared dataset packaging are future product surfaces over this shared core. Each remains future capability until independently approved by Tolani commercial-context and rights gates.
