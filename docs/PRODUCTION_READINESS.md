# Production Readiness

The production target is intentionally split into **infrastructure bootstrap**, **runtime acceptance**, and **release authority**.

## Current production state

`env.production` is a disabled deployment envelope. It uses production-specific Cloudflare resource names, but it does not grant traffic, ingestion, external-provider egress, MCP, public API, provider promotion, billing, or commercial authority.

Expected production resources:

- Worker: `tmg-video-services-production`
- R2: `tmg-video-assets-prod`
- Vectorize: `tmg-video-segments-512-prod`
- Workflow: `tmg-video-ingestion-prod`
- Workflow: `tmg-video-revocation-prod`
- Durable Object: `TenantUsageLedger` through `TENANT_USAGE_LEDGER`

The read-only audit on 2026-08-22 authenticated successfully and proved that the Worker bundle compiles, but the R2 bucket, Vectorize index, and both Workflows do not yet exist.

## Read-only audit

`.github/workflows/production-readiness.yml` targets the GitHub Environment `production` and performs only read-only Cloudflare queries plus `wrangler deploy --env production --dry-run`.

The audit verifies:

1. Cloudflare production credentials are available through the GitHub Environment.
2. The expected R2 bucket exists.
3. The expected Vectorize index exists.
4. The expected ingestion and revocation Workflows exist.
5. Production bindings generate successfully.
6. The production Worker bundle compiles without a live deploy.
7. An evidence artifact and sanitized Issue #18 report are emitted for the run.

The readiness workflow must not create, delete, trigger, deploy, or mutate production resources.

## Manual infrastructure bootstrap

`.github/workflows/production-bootstrap.yml` is the only authorized infrastructure-bootstrap path. It is `workflow_dispatch` only and has no push, pull-request, or schedule trigger.

Before any Cloudflare mutation it requires all of the following live evidence:

1. The workflow is dispatched from `main`.
2. `expected_sha` exactly equals the dispatched `main` SHA.
3. The caller supplies the exact authorization phrase `BOOTSTRAP_DISABLED_PRODUCTION_INFRASTRUCTURE`.
4. GitHub reports `main` as protected.
5. Issue #14 is closed with branch-protection evidence.
6. The exact SHA has a successful GitHub Actions `validate` check.
7. The production Cloudflare API token is present and the account is `d20586cf099d39fcbeb5db4043e20f6f`.
8. Repository checks, production type generation, and production dry-run pass before mutation.

If all gates pass, the workflow may only:

- create `tmg-video-assets-prod` if it does not already exist;
- create `tmg-video-segments-512-prod` if it does not already exist and verify the 512-dimension/cosine contract;
- create and verify the eight rights/publication metadata indexes before any vector insertion;
- deploy the disabled, non-routed `tmg-video-services-production` Worker so the production Workflows and `TenantUsageLedger` Durable Object namespace exist;
- perform post-bootstrap read-only verification and publish evidence to Issue #18.

The bootstrap workflow must not delete production resources, trigger Workflows, write secrets, publish media, enable ingestion, enable public API/MCP, enable external-provider egress, route traffic, promote Marengo, activate billing, or grant commercial authority.

## Release sequence

The controlled production sequence is:

1. Protect `main` and close Issue #14 with evidence.
2. Verify exact-head Quality on the intended `main` SHA.
3. Execute the manual disabled-infrastructure bootstrap.
4. Bind successful bootstrap evidence to `productionInfrastructureBootstrap`.
5. Re-run the read-only Production Readiness Audit until all infrastructure checks pass.
6. Run isolated tenant authentication/isolation, entitlement, quota, and usage-ledger acceptance against the disabled production plane.
7. Add abuse controls and billing mapping where applicable.
8. Obtain explicit provider/public/commercial release approval.
9. Promote individual capabilities separately; do not use infrastructure existence as capability authority.

Even after infrastructure bootstrap, the following remain separate release gates:

- tenant authentication and tenant isolation acceptance;
- entitlement enforcement acceptance;
- quota and usage-meter persistence acceptance;
- abuse controls;
- billing mapping;
- explicit provider promotion approval;
- explicit public API/MCP/commercial release approval.

Marengo remains `shadow_only` until those gates are explicitly promoted. Vectorization or a successful production deployment never expands source-media rights.
