# TMG Storyboard & Brand Composition v1.1

## Mission

Turn verified campaign context plus approved visual assets into a reviewed, multi-shot, brand-composed storyboard system that can drive both human campaign review and future paid video rendering.

This increment is review-only. It does not grant publication authority, external-distribution authority, or paid P-Video execution authority.

## Runtime topology

```text
authorized website/app
  -> Firecrawl governed discovery
  -> tmg.campaign-context.v1
  -> tmg.marketing-creative-brief.v1
  + accepted tmg.image-asset-manifest.v1
  -> multi-shot planner
  -> Workers AI FLUX shot generation
  -> exact approved-logo composition through Cloudflare Images
  -> tmg.storyboard-manifest.v1.1
  -> deterministic title/end-card treatment
  -> target-specific H.264 review mockups
  -> tmg.video-render-plan.v1
  -> human review
  -> P-Video only after separate provider-capacity/acceptance authority
```

## Files

Core runtime:
- `src/storyboard-brand-composition.ts` — contracts, planner, R2 keys, title/end-card specs and `VideoRenderPlan` compiler.
- `src/storyboard-brand-composition-workflow.ts` — Workers AI + Cloudflare Images + R2 Workflow.
- `src/index.ts` — exports `StoryboardBrandCompositionWorkflow`.

Validation:
- `tests/storyboard-brand-composition.test.ts`
- `scripts/render-storyboard-brand-composition-acceptance-config.mjs`
- `scripts/prepare-storyboard-brand-composition-acceptance.mjs`
- `scripts/verify-storyboard-brand-composition-acceptance.mjs`
- `scripts/render-storyboard-v11-motion-preview.mjs`
- `.github/workflows/storyboard-brand-composition-acceptance.yml`

## Canonical contracts

### `tmg.storyboard-manifest.v1.1`

Contains:
- request and tenant identity;
- immutable creative brief and `ImageAssetManifest` references;
- three target-specific shot boards;
- three shots per target: `hook`, `product_value`, `cta`;
- exact shot timing whose sum equals the target duration;
- Workers AI raw-frame provenance;
- composed-frame SHA evidence;
- exact approved-logo SHA evidence;
- title/end-card specifications;
- rights evidence;
- human-review and publication/distribution authority state.

### `tmg.video-render-plan.v1`

Contains:
- immutable StoryboardManifest reference;
- target profiles and shot timing;
- shot prompts;
- composed-frame object keys and SHA-256 references;
- preferred future provider `pruna/p-video`;
- `storyboardGroundingRequired=true`;
- `executionState=disabled_pending_provider_capacity`;
- `paidProviderExecutionAuthorized=false`.

The render plan is a handoff artifact. It cannot activate paid rendering by itself.

## ImageAssetManifest dependency

The Workflow accepts only `tmg.image-asset-manifest.v1` records that satisfy all of the following:
- same tenant as the creative request;
- `rights.evidenceState=verified`;
- `rights.purpose=marketing_creative`;
- `sourceReuseAuthorized=true`;
- `logoOverlayAuthorized=true`;
- valid approved-logo SHA-256;
- `humanReviewRequired=true`;
- `publicationAuthority=false`;
- `externalDistributionAuthority=false`.

The approved logo object is fetched and re-hashed immediately before composition. A changed logo fails closed.

## Multi-shot planning

Every creative target receives exactly three v1.1 shots:
1. `hook`
2. `product_value`
3. `cta`

Shot durations are deterministic and sum exactly to the target profile duration. Generated prompts may use verified brand palette/context as guidance, but explicitly prohibit generated typography, exact logos, screenshots, UI, discovered assets, unsupported claims, awards, customer counts, guarantees, prices, testimonials, endorsements, performance claims and invented capabilities.

Rights-cleared image derivatives may be referenced as supporting visual evidence, but FLUX is told not to recreate or imitate them. Exact assets are handled by deterministic composition.

## Generation and composition boundary

### Workers AI

Model: `@cf/black-forest-labs/flux-1-schnell`

Purpose: scene/keyframe concept generation only.

Each raw frame is:
- JPEG or PNG;
- SHA-256 bound;
- stored privately under the tenant/request scope;
- marked immutable and review-only.

### Cloudflare Images

Purpose: deterministic brand composition.

For each shot:
- generated frame is cropped/resized to target dimensions;
- approved logo is independently read from R2 and SHA-verified;
- exact logo bytes are overlaid at full opacity;
- output is WebP;
- output SHA, raw-frame SHA, logo SHA and rights evidence are recorded.

Generated models never receive authority to recreate an exact logo.

## R2 key conventions

Root:

```text
tenants/{tenantId}/production-requests/{requestId}/storyboard-v1-1/
```

Control artifacts:

```text
control/storyboard-manifest-v1.1.json
control/video-render-plan-v1.json
```

Per shot:

```text
{targetProfileId}/shots/{shotId}/raw.jpg
{targetProfileId}/shots/{shotId}/raw.png
{targetProfileId}/shots/{shotId}/composed.webp
```

Image Runtime authority remains in its original namespace:

```text
tenants/{tenantId}/image-runtime/{imageRequestId}/control/image-asset-manifest-v1.json
```

## Title and end cards

The canonical StoryboardManifest contains deterministic title/end-card specifications referencing the first and last composed shot frames plus the exact approved logo reference.

The isolated acceptance renders review-card PNGs with deterministic ffmpeg typography. These files are presentation artifacts for review ergonomics; the canonical authority remains the StoryboardManifest/card specification and composed-frame evidence.

## Target-specific motion mockups

Acceptance compiles three review-only H.264 MP4s:
- TikTok organic: 9:16, target duration 7 seconds;
- YouTube Shorts: 9:16, target duration 8 seconds;
- Website hero: 16:9, target duration 6 seconds.

Each mockup uses the target's exact shot timing. ffprobe verifies codec, dimensions and duration. These are deterministic storyboard review mockups, not P-Video outputs.

## Workflow boundaries

### Context plane

Existing governed production request/Firecrawl Workflow creates campaign context and the immutable marketing creative brief. Marketing video generation remains disabled in the v1.1 acceptance context Worker.

### Storyboard brand composition plane

`StoryboardBrandCompositionWorkflow` receives only:
- canonical creative brief key;
- canonical same-tenant `ImageAssetManifest` key;
- request/tenant identity.

It generates and composes frames, persists the immutable StoryboardManifest, and compiles the VideoRenderPlan.

### Paid render plane

Not activated by v1.1. `pruna/p-video` remains a separately accepted paid provider. Loading credits does not itself grant execution or publication authority.

## Acceptance structure

`TMG Storyboard Brand Composition v1.1 Acceptance` must prove:
1. exact-head typecheck/tests/commercial-context validation;
2. isolated temporary R2 provision;
3. isolated Firecrawl context Worker/Workflow;
4. isolated AI + Images renderer Workflow;
5. authorized synthetic website fixture;
6. immutable 90-quality-class creative context/brief path;
7. tenant-scoped synthetic rights-cleared `ImageAssetManifest`;
8. real Workers AI generation of 9 raw shots;
9. real Cloudflare Images composition of 9 WebPs using the exact approved-logo bytes;
10. SHA verification of all 9 composed outputs;
11. 3 target StoryboardManifest sections with 3 shots each;
12. title/end-card specifications for every target;
13. immutable `VideoRenderPlan` with paid execution disabled;
14. 3 deterministic H.264 motion mockups with expected dimensions/durations;
15. sanitized evidence upload;
16. deletion of both temporary Workers;
17. deletion of every temporary R2 object and bucket;
18. success status only after teardown succeeds.

## Governance invariants

- crawl authorization is not asset reuse authorization;
- ImageAssetManifest is the visual rights authority input;
- tenant scopes may not cross;
- exact logos come only from approved bytes;
- approved logo is re-hashed immediately before composition;
- generated frames have zero publication authority;
- composed frames have zero publication authority;
- title/end cards and mockups are review-only;
- `VideoRenderPlan` cannot authorize P-Video execution;
- human review is mandatory;
- no production activation is introduced;
- no secrets or customer media are included in CI evidence;
- acceptance uses synthetic rights-cleared media only.

## PR scope

This v1.1 increment is intentionally limited to:
- multi-shot planning;
- governed FLUX storyboard generation;
- exact rights-cleared logo composition;
- immutable StoryboardManifest;
- deterministic title/end-card specifications and acceptance rendering;
- target-specific motion review mockups;
- immutable P-Video `VideoRenderPlan` handoff with execution disabled;
- isolated acceptance and teardown evidence.

Excluded from this increment:
- production activation;
- public image/storyboard processing endpoints;
- automated publication/distribution;
- P-Video execution;
- generative recreation of logos or customer assets;
- generative image editing of approved assets;
- approval bypasses.
