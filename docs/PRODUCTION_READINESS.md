# Production Readiness

The production target is intentionally split into **infrastructure bootstrap**, **runtime acceptance**, **tenant authentication/entitlement acceptance**, and **release authority**.

## Current production state

`env.production` remains a disabled deployment envelope. Production infrastructure now exists and has been reconciled, fingerprinted, independently audited, and acceptance-tested, but those facts do not grant traffic or capability authority.

Current production resources:

- Worker: `tmg-video-services-production`
- R2: `tmg-video-assets-prod`
- Vectorize: `tmg-video-segments-512-prod`
- Workflow: `tmg-video-ingestion-prod`
- Workflow: `tmg-video-revocation-prod`
- Durable Object: `TenantUsageLedger` through `TENANT_USAGE_LEDGER`

Frozen infrastructure fingerprint:

`feb4e3cc93d57c8390a02abece1bdf3a04e905128012480197bd23068ff4f00c`

Production still grants **no** general traffic, ingestion, external-provider egress, MCP, public API, provider promotion, billing, or commercial authority. The runtime flags remain fail-closed.

## Bound production evidence

The repository currently binds the following verified evidence without treating it as release authority:

- infrastructure bootstrap: run `32590468035`;
- infrastructure reconciliation: run `32592457936`;
- Runtime Acceptance v1: run `32606309623`;
- Tenant Authentication + Entitlement Acceptance v1: run `32618053032`;
- independent post-auth Production Readiness: run `32618129969`;
- auth evidence binding: PR #39, merged as `4e62a9f042bb18110d954b37e4bcf7b4c3958e46`;
- post-binding Quality: run `32618364782`;
- post-binding Production Readiness: run `32618364793`.

The required release gates in `config/production-release-policy.json` remain unsatisfied where release authority is concerned. Evidence and authority are intentionally separate concepts.

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

The readiness workflow must not create, delete, trigger, deploy, route, or otherwise mutate production resources.

## Manual infrastructure bootstrap

`.github/workflows/production-bootstrap.yml` remains the only authorized infrastructure-bootstrap path. The completed bootstrap evidence is historical authority for those exact infrastructure mutations only; it is not reusable as capability activation authority.

The bootstrap workflow must not delete production resources, trigger Workflows, write secrets, publish media, enable ingestion, enable public API/MCP, enable external-provider egress, route traffic, promote Marengo, activate billing, or grant commercial authority.

## Runtime and tenant acceptance

Runtime Acceptance v1 proved the production `TenantUsageLedger` behavior for tenant isolation, idempotency, quota-before-insert, UTC windows, and persistence without changing the disabled production envelope.

Tenant Authentication + Entitlement Acceptance v1 then proved cryptographic authentication, canonical principal-to-tenant binding, default-deny entitlement enforcement, caller-tenant override rejection, side-effect-free denials, tenant isolation, and persistent replay rejection against the frozen production envelope.

Both evidence packages are repository-bound. Neither grants release authority.

## Release authority design

Issue #40 and `docs/PRODUCTION_RELEASE_AUTHORITY.md` define the next layer: a separately reviewed Production Release / Activation Authority v1 design.

The first eligible capability is intentionally narrower than public launch:

- authenticated, allowlisted vector-search canary;
- `internal_search` only;
- fixture provider only;
- non-billable;
- no MCP;
- no ingestion;
- no external-provider egress;
- no Marengo promotion;
- no general public API;
- no commercial authority.

The release-authority design is enforced by `config/production-release-authority.json` and `scripts/production-release-authority-policy-check.mjs`. Design review does not itself provide an executable release workflow.

## Controlled release sequence

The controlled sequence is now:

1. Keep protected `main` and exact-head Quality green.
2. Preserve the frozen infrastructure fingerprint and existing acceptance evidence.
3. Review and merge the Release / Activation Authority v1 **design only**.
4. Separately implement an immutable release manifest and canary ingress.
5. Separately implement a stage-scoped human approval verifier and non-replayable release workflow.
6. Begin with a 0% normal-traffic operator smoke stage, then advance only through explicitly approved canary ceilings.
7. Capture last-known-good Worker version before every traffic mutation.
8. Execute zero-drift and Production Readiness checks after every stage mutation.
9. Keep public API/MCP blocked until abuse controls are accepted.
10. Keep billing/commercial release blocked until billing mapping, usage-to-invoice reconciliation, dispute/refund semantics, and explicit commercial approval are accepted.
11. Promote external providers only through separate provider acceptance and promotion authority.

## Still-separate release gates

Even with successful production acceptance, the following remain separate:

- canary ingress implementation and review;
- abuse controls;
- billing mapping;
- immutable release-manifest generation;
- stage-specific human release approval;
- rollback/kill-switch implementation and acceptance;
- explicit provider promotion approval;
- explicit public API/MCP/commercial release approval.

Marengo remains `shadow_only`. Vectorization, infrastructure existence, a passing readiness audit, or a successful Worker deployment never expands source-media rights or commercial authority.
