# Development Infrastructure Acceptance + Revocation E2E

## Scope

This acceptance lane is restricted to isolated Cloudflare development resources and the repository-owned harmless fixture.

It proves:

1. a private R2 bucket is created;
2. a fresh 512-dimension cosine Vectorize index is created;
3. all eight metadata indexes exist before any vector is inserted;
4. the harmless fixture is uploaded to private R2;
5. the ingestion Workflow is temporarily enabled while public REST and MCP remain disabled;
6. exactly one `review` vector is created;
7. internal retrieval can find that vector while every commercial/external grant remains false;
8. the revocation Workflow creates rights revision 2 and requests `deleteByIds()` for the one recorded vector;
9. retrieval eventually returns zero fixture matches after the asynchronous Vectorize mutation is applied;
10. the media object, manifest, original rights revision, revoked rights revision, revoked index receipt, and revocation event remain in R2 for audit;
11. the acceptance Worker is redeployed with fixture ingestion disabled.

## Isolation

The GitHub Actions acceptance run generates unique resource names from `github.run_id`:

- Worker: `tmg-video-accept-<run-id>`
- R2 bucket: `tmg-video-accept-<run-id>`
- Vectorize index: `tmg-video-accept-<run-id>`
- ingestion Workflow: `tmg-video-ingest-accept-<run-id>`
- revocation Workflow: `tmg-video-revoke-accept-<run-id>`

`workers_dev` is false and there are no public routes. `TMG_PUBLIC_API_ENABLED` and `TMG_MCP_ENABLED` remain false for the full run.

## Required GitHub secrets

The one-run workflow expects:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The token must be scoped narrowly enough to this development acceptance task while allowing the required Workers/Workflows, R2, and Vectorize operations.

## Metadata indexes

The acceptance harness creates and waits for these indexes before fixture ingestion:

- `tenantId` — string
- `rightsVerified` — boolean
- `publicationState` — string
- `externalApi` — boolean
- `mcp` — boolean
- `advertising` — boolean
- `datasetExport` — boolean
- `licensing` — boolean

No vector insertion is permitted until all eight appear in the Vectorize metadata-index list.

## Evidence artifact

A successful run uploads an Actions artifact containing:

- `acceptance-evidence.json`
- `metadata-indexes.json`
- `query-pre-ingest.json`
- `query-post-ingest.json`
- `query-post-revocation.json`
- `ingestion-workflow.txt`
- `revocation-workflow.txt`

The acceptance verdict is not inferred from a successful deployment alone. The run must independently prove one vector after ingestion, zero matching vectors after revocation, and preserved R2 evidence.
