# Production Release / Activation Authority v1

## Status

Release-control mechanics are implemented for **S0 and S1 only** and remain **unactivated**. Controlling design: Issue #40. Implementation: Issue #42.

The implementation does not authorize production traffic, public API, MCP, ingestion, external-provider egress, provider promotion, billing, commercial use, or S2+ rollout. The repository remains default-deny and the production runtime flags remain false/unverified.

## First capability

The only capability named by Release Authority v1 is `tenant_authenticated_vector_search_canary_v1` with these immutable boundaries:

- purpose: `internal_search`;
- tenant cohort: `production_canary_v1`;
- provider: `fixture` only;
- maximum provider authority: `fixture`;
- Marengo: `shadow_only`;
- billing: non-billable;
- general public API: false;
- MCP: false;
- ingestion: false;
- external-provider egress: false;
- commercial use: false.

S0/S1 do **not** expose the tenant capability to normal users. S1 is operator smoke only.

## Implemented artifacts

- `.github/workflows/production-release-s0-s1.yml` — manual protected-main release workflow.
- `config/production-release-manifest.schema.json` — immutable release-manifest contract.
- `scripts/build-production-release-manifest.mjs` — deterministic manifest builder using write-once files.
- `config/production-stage-approval.schema.json` — exact S1 approval envelope.
- `scripts/verify-production-stage-approval.mjs` — human-author, expiration, exact-binding, and replay checks.
- `config/wrangler.production-s1-canary-ingress.jsonc` — route-less ephemeral ingress with one Service Binding to `tmg-video-services-production`.
- `scripts/production-release-s1-canary-ingress.mjs` — operator-only smoke proxy using Cloudflare Worker version override.
- `scripts/extract-production-lkg-version.mjs` — last-known-good capture.
- `scripts/verify-production-s1-deployment.mjs` — exact `candidate@0% / LKG@100%` verification.
- `scripts/snapshot-production-runtime-surface.mjs` and `scripts/compare-production-runtime-surfaces.mjs` — governed-surface reconciliation.

## S0 — prepared candidate, no active-deployment change

S0 requires a manual workflow dispatch from protected `main`, exact successful Quality, closed prerequisite issues, frozen fingerprint match, and the authorization phrase `PREPARE_TMG_PRODUCTION_S0_V1`.

S0 then:

1. captures the current single 100% last-known-good Worker version;
2. uploads a new Worker version with `wrangler versions upload`;
3. resolves the exact new version ID by its unique tag;
4. builds the immutable release manifest and SHA-256;
5. proves the active deployment is still the same single last-known-good version at 100%;
6. proves governed production surfaces have no unexpected delta;
7. reruns read-only production readiness checks;
8. publishes an evidence artifact.

Uploading a version is not S1 approval and does not route normal production traffic to the candidate.

## S1 — operator smoke, candidate at 0% normal traffic

S1 is not authorized by merging the implementation or by completing S0. A separate human-authored approval is required.

The workflow reconstructs the S0 manifest from the exact candidate SHA, candidate Worker version ID, last-known-good version ID, and original S0 run ID. Its SHA-256 must equal the S0 artifact digest.

Only then may S1 validate a human approval and create the deployment composition:

- candidate version: **0% normal traffic**;
- last-known-good version: **100% normal traffic**.

The S1 operator smoke runs through an ephemeral remote-development Worker with no route, no custom domain, workers.dev disabled, preview URLs disabled, and exactly one Service Binding to the production Worker. It forwards only a health probe to the candidate using `Cloudflare-Workers-Version-Overrides` and verifies the candidate still reports G0, public API disabled, and MCP disabled.

The ephemeral ingress is stopped before post-stage surface reconciliation.

## Human S1 approval format

The approval must be a human-authored comment on a **separate open release issue**, never Issue #42. The body must be exactly the prefix followed by a single JSON object:

```text
APPROVE_TMG_RELEASE_STAGE_V1 {"schemaVersion":"1.0.0","approvalId":"<unique-id>","humanAuthor":"<github-login>","automationAuthored":false,"protectedMainSha":"<40-char-sha>","workerVersionId":"<candidate-version-id>","releaseManifestSha256":"<64-char-sha256>","capabilityId":"tenant_authenticated_vector_search_canary_v1","stageId":"S1","tenantCohortId":"production_canary_v1","issuedAt":"<ISO-8601>","notAfter":"<ISO-8601 <= 30 minutes later>","noOtherCapabilityAuthorized":true}
```

The verifier rejects:

- bot/automation authors;
- author mismatch;
- wrong SHA/version/manifest/capability/cohort/stage;
- approvals broader than the named capability;
- expired or future-dated approvals;
- validity windows longer than 30 minutes;
- an `approvalId` already recorded in a `CONSUMED_TMG_RELEASE_APPROVAL_V1` receipt.

A successful S1 run records a consumption receipt on the release issue. Automation validates and consumes approval; it does not create approval.

## Rollback and kill switch

If any S1 step fails after the split deployment is created, the workflow invokes `wrangler rollback <last-known-good-version>` with a deterministic rollback message. The selected last-known-good version becomes the active deployment at 100%.

After rollback the workflow captures deployment state, production surface evidence, and a production deploy dry-run.

Worker rollback is not storage rollback. Therefore S0/S1 prohibit Durable Object lifecycle/schema migrations and destructive R2/Vectorize changes. Any future storage migration requires its own compatibility and recovery gate.

## Post-stage reconciliation

S0 and S1 require:

- before/after production surface snapshots;
- zero unexpected changes to Worker bindings/runtime flags, R2, Vectorize, Workflows, Durable Object namespace, routes/domains, or persistent acceptance/canary scripts;
- Cloudflare identity check;
- R2 read;
- Vectorize read;
- ingestion/revocation Workflow reads;
- production `wrangler deploy --dry-run`.

S1 is successful only if the deployment remains candidate 0% / LKG 100%, operator smoke passes, governed surfaces reconcile, and readiness remains green.

## Not implemented / not authorized

S2, S3, S4, and S5 execution paths do not exist in the v1 workflow. The workflow contains no 1%, 5%, or 25% rollout action.

Still blocked:

- allowlisted tenant traffic at S2;
- public API and MCP until abuse controls are accepted;
- external-provider promotion and egress;
- billing mapping and invoiceable events;
- commercial release;
- any storage/schema migration coupled to release.

A successful S0 or S1 run never implies authority for any of those capabilities.
