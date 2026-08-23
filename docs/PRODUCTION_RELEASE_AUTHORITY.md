# Production Release / Activation Authority v1

## Status

This document is a **design-only release authority contract**. It does not authorize production traffic, deployment mutation, route mutation, public API, MCP, ingestion, external-provider egress, provider promotion, billing, or commercial use.

Controlling design issue: #40.

Authoritative design starting point:

- protected main: `4e62a9f042bb18110d954b37e4bcf7b4c3958e46`
- frozen infrastructure fingerprint: `feb4e3cc93d57c8390a02abece1bdf3a04e905128012480197bd23068ff4f00c`
- live Runtime Acceptance v1: `32606309623`
- live Tenant Authentication + Entitlement Acceptance v1: `32618053032`
- independent post-auth Production Readiness: `32618129969`
- auth evidence binding PR: #39
- post-binding Quality: `32618364782`
- post-binding Production Readiness: `32618364793`

Acceptance evidence is necessary but **not sufficient** for release authority.

## Release principle

Production release is capability-scoped, stage-scoped, tenant-scoped, evidence-bound, and human-approved.

The following events never grant authority on their own:

- infrastructure existence;
- a successful acceptance suite;
- a successful Worker upload or deployment;
- a successful Production Readiness audit;
- a previously approved stage;
- a previous release approval for another SHA, version, capability, tenant cohort, or stage.

Default decision is deny.

## First eligible capability

The first production capability is intentionally smaller than a public launch:

**`tenant_authenticated_vector_search_canary_v1`**

It is constrained to:

- authenticated production identities only;
- explicit allowlisted canary tenants only;
- canonical tenant binding with no caller-controlled tenant override;
- `internal_search` purpose only;
- fixture provider only;
- fixture maximum provider authority only;
- non-billable operation;
- no general public API authority;
- no MCP authority;
- no ingestion authority;
- no external-provider egress;
- no Marengo promotion;
- no commercial-use authority.

A separate canary ingress must be designed and reviewed before this capability can be exercised. The first canary must **not** be implemented by simply setting `TMG_PUBLIC_API_ENABLED=true`.

## Canary stages

### S0 — Prepared / zero authority

The candidate may be built, tested, packaged, fingerprinted, and uploaded as an artifact. No production route, deployment, or traffic mutation is authorized.

### S1 — Operator smoke / 0% normal traffic

After a separate canary ingress has been reviewed, a new Worker version may be represented in a split deployment at 0% normal traffic. Authorized operator smoke requests may explicitly target that version. Normal users receive no canary traffic.

### S2 — Allowlisted canary / <=1%

At most one percent deployment share. Only eligible, authenticated, explicitly allowlisted canary tenants may exercise the named capability. All other capability attempts fail closed.

### S3 — Expanded canary / <=5%

At most five percent deployment share. Requires a new stage-specific human approval and green evidence from S2.

### S4 — Controlled production / <=25%

At most twenty-five percent deployment share. Still allowlisted, fixture-only, non-billable, and non-public. Requires a new stage-specific human approval and green evidence from S3.

### S5 — Full Worker version / capability still scoped

The candidate Worker version may reach 100% of Worker-version deployment only after all prior stages are green. This does **not** mean public launch. Tenant allowlisting, fixture-only provider authority, non-billable operation, and all capability gates remain in force.

## Stage-transition evidence

Every stage transition after S0 must be bound to:

1. exact protected-main SHA;
2. exact Cloudflare Worker version ID;
3. immutable release-manifest SHA-256;
4. successful exact-head Quality;
5. successful live Production Readiness;
6. zero unexpected production infrastructure/runtime delta;
7. successful evidence from the immediately preceding stage;
8. a one-time human approval for the exact capability and stage;
9. a recorded last-known-good Worker version for rollback;
10. proof that the v1 candidate contains no Durable Object lifecycle/schema migration or destructive storage/index migration.

No stage approval may be inherited by another stage.

## Health and abort guardrails

The following are immediate hard-stop conditions:

- authentication bypass;
- tenant crossover or cross-tenant data exposure;
- entitlement bypass;
- denied operation causing a governed side effect;
- rights/publication boundary violation;
- quota or usage-ledger corruption;
- unexpected Worker route, binding, Workflow, R2, or Vectorize delta;
- unauthorized provider activity;
- unauthorized billing or invoiceable event;
- unauthorized commercial capability.

Operational soft guardrails for the first canary include:

- rollback if the candidate's relevant 5xx rate reaches 2% for the release observation window;
- rollback if accepted request latency reaches 2.5x the accepted baseline without an explained, approved cause;
- zero tolerance for tenant isolation, rights, authorization, or billing violations.

A future release manifest must define the exact observation window and accepted baseline used for that release. Those values are release evidence, not implied by this design document.

## Kill switch and rollback order

The emergency stop sequence is:

1. fail the named capability closed at the application/policy layer;
2. revoke canary tenant eligibility and affected credentials;
3. deny or remove the canary ingress, as applicable;
4. roll Worker traffic to the recorded last-known-good version at 100%;
5. execute read-only reconciliation and Production Readiness;
6. publish a sanitized rollback evidence package.

Rollback is not equivalent to storage rollback. Worker versions do not snapshot R2, Vectorize, or Durable Object state. For that reason, Release Authority v1 prohibits Durable Object lifecycle/schema migrations and destructive storage/index changes in the first activation candidate. Any future storage migration requires its own forward/backward compatibility, recovery, and rollback gate.

## Tenant eligibility

A tenant is ineligible unless all conditions are satisfied:

- production identity enabled;
- credential cryptographically authenticated;
- canonical tenant mapping verified;
- explicit `production_canary_v1` cohort membership;
- default-deny entitlement resolves to allow only for the named capability;
- approved purpose is `internal_search`;
- provider is `fixture` with maximum authority `fixture`;
- persistent quota policy exists;
- relevant source/media rights policy is satisfied;
- no unresolved isolation, replay, or abuse finding;
- billing mode is non-billable;
- tenant is not represented as generally commercially available.

Canary membership is revocable and never implied by account existence.

## Provider authority

Release Authority v1 does not promote an external provider.

- authoritative provider: `fixture`
- Marengo: `shadow_only`
- external-provider egress: false
- authoritative external embedding: false
- external-provider commercial claims: false

Any external-provider promotion requires separate provider acceptance, rights/privacy/cost review, and explicit promotion approval.

## Abuse, billing, and commercial gates

Public API and MCP release remain blocked until abuse controls are implemented and accepted.

Commercial release remains blocked until all of the following are separately reviewed and green:

- abuse controls;
- billing mapping;
- usage-to-invoice reconciliation;
- dispute/refund semantics;
- explicit commercial release approval.

The first canary is non-billable. Usage telemetry may be recorded for governance, but it must not become an invoiceable event.

## Human release approval

Automation may collect evidence, build manifests, verify fingerprints, and execute pre-approved deterministic checks. Automation may **not** grant release authority.

Every stage approval must be human-authored, one-time, non-replayable, and bound to all of:

- protected-main SHA;
- Worker version ID;
- release-manifest SHA-256;
- capability ID;
- stage ID;
- tenant cohort ID;
- not-after bound;
- explicit statement that no other capability is authorized.

The implementation workflow must reject stale approvals, replayed approvals, approvals for broader capabilities, approvals for a different SHA/version/manifest, and automation-authored approvals.

## Cloudflare release mechanics

The implementation should use versioned Worker release mechanics rather than `wrangler deploy` directly to 100% traffic. The intended sequence is upload version -> establish controlled deployment -> use 0%/low-percentage canary stages -> promote only with evidence -> rollback to the recorded stable version when required.

Because Durable Objects can be pinned to Worker versions differently from ordinary request traffic, release evidence must inspect Durable Object behavior and actual observed traffic, not only configured percentages.

## What remains to implement

This design does not provide a release workflow. A later implementation must add, in a separate reviewed increment:

- a dedicated release-manifest schema;
- a production release workflow with exact-SHA/version/manifest validation;
- a separately reviewed canary ingress;
- human stage-approval parsing and replay protection;
- last-known-good version capture;
- kill-switch and rollback commands;
- stage evidence packaging;
- post-stage reconciliation/readiness;
- abuse-control acceptance before public API/MCP;
- billing mapping before any commercial release.

Until those artifacts exist and are separately accepted, production remains in the disabled envelope.
