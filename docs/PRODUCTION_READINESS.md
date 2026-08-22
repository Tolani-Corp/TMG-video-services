# Production Readiness

The production target is intentionally split into **infrastructure readiness** and **release authority**.

## Current production state

`env.production` is a disabled deployment envelope. It uses production-specific Cloudflare resource names, but it does not grant traffic, ingestion, external-provider egress, MCP, public API, provider promotion, billing, or commercial authority.

Expected production resources:

- Worker: `tmg-video-services-production`
- R2: `tmg-video-assets-prod`
- Vectorize: `tmg-video-segments-512-prod`
- Workflow: `tmg-video-ingestion-prod`
- Workflow: `tmg-video-revocation-prod`
- Durable Object: `TenantUsageLedger` through `TENANT_USAGE_LEDGER`

## Read-only audit

`.github/workflows/production-readiness.yml` targets the GitHub Environment `production` and performs only read-only Cloudflare queries plus `wrangler deploy --env production --dry-run`.

The audit verifies:

1. Cloudflare production credentials are available through the GitHub Environment.
2. The expected R2 bucket exists.
3. The expected Vectorize index exists.
4. The expected ingestion and revocation Workflows exist.
5. Production bindings generate successfully.
6. The production Worker bundle compiles without a live deploy.
7. An evidence artifact is emitted for the run.

The workflow must not create, delete, trigger, deploy, or mutate production resources.

## Production mutation gate

No production resource creation or Worker deployment is authorized until all gates in `config/production-release-policy.json` are evidenced. In particular, GitHub Issue #14 must be closed with repository-protection evidence before production mutation or capability activation.

Even after infrastructure bootstrap, the following remain separate release gates:

- tenant authentication and tenant isolation acceptance;
- entitlement enforcement acceptance;
- quota and usage-meter persistence acceptance;
- abuse controls;
- billing mapping;
- explicit provider promotion approval;
- explicit public API/MCP/commercial release approval.

Marengo remains `shadow_only` until those gates are explicitly promoted. Vectorization or a successful production deployment never expands source-media rights.
