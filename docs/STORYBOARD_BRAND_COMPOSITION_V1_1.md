# TMG Storyboard & Brand Composition v1.1

## Mission

Turn verified campaign context plus approved visual assets into a reviewed, multi-shot, brand-composed storyboard system that can drive both human campaign review and future paid video rendering.

This increment is deliberately stacked on the accepted Marketing/Image/Workers AI preview baseline. It does not grant publication authority, external-distribution authority, or paid-provider execution authority.

## Canonical flow

```text
verified tmg.marketing-creative-brief.v1
+ verified tmg.image-asset-manifest.v1
        |
        v
composition-ready tmg.image-asset-manifest.v1.1
        |
        v
multi-shot target planning
        |
        +--> FLUX concept frames (no exact assets / no typography)
        |
        v
Cloudflare Images deterministic composition
  + exact approved logo
  + exact authorized platform derivative on product/feature shots
        |
        v
tmg.storyboard-manifest.v1.1
  + title visual plate
  + end visual plate
        |
        v
deterministic target motion review mockups
        |
        v
tmg.video-render-plan.v1
  provider = pruna/p-video
  providerExecutionAuthorized = false
        |
        v
human review / future paid-provider acceptance
```

## Runtime boundaries

### Workers AI / FLUX

`@cf/black-forest-labs/flux-1-schnell` creates scene concepts only. Prompts explicitly prohibit exact logos, exact product screenshots, discovered assets, third-party marks, typography, watermarks, and unsupported marketing claims.

The generated project types are authoritative for the Worker call. v1.1 uses four diffusion steps and does not claim a provider seed is applied.

### Cloudflare Images

Cloudflare Images performs the deterministic exact-asset composition after FLUX generation. Every exact asset is re-read from private R2 and SHA-256 verified against the authorized ImageAssetManifest before use.

Every composed shot receives the approved logo. `product_showcase` and `feature_value` shots additionally receive the target-appropriate authorized platform derivative. A mismatch between expected and actual source, logo, derivative, composition-plan, or output SHA fails closed.

### Title and end cards

The Worker creates target-sized deterministic visual plates from an authorized platform derivative plus the exact approved logo. The card manifest carries verified title/support/CTA copy, but `textRenderedInImage=false` in the Worker artifact. The isolated deterministic motion renderer applies that verified copy for review ergonomics. No generative model is permitted to reproduce brand text or legal copy.

### Paid video provider

`tmg.video-render-plan.v1` is a handoff artifact only. It references reviewed composed frames and cards, but:

- provider is `pruna/p-video`;
- activation state is `disabled_until_paid_acceptance`;
- `providerExecutionAuthorized=false`;
- publication and external distribution remain false.

The plan does not execute P-Video and cannot bypass the separate paid-provider acceptance gate.

## Multi-shot target plans

The initial deterministic shot templates are:

- TikTok and other vertical social targets: `hook -> product_showcase -> cta`.
- YouTube Shorts: `hook -> problem -> product_showcase -> cta`.
- Website/web-app hero: `product_showcase -> feature_value -> cta`.

Shot durations are derived from the target profile and sum to the declared target duration. Copy can only be projected from the verified `MarketingCreativeBrief`.

## Canonical artifacts

### `tmg.image-asset-manifest.v1.1`

An immutable projection of the accepted v1 manifest. It records:

- source v1 manifest object key and SHA;
- exact approved logo requirement;
- exact product-asset authorization requirement;
- authorized source/logo/platform-derivative assets;
- composition defaults;
- inherited rights and governance.

### `tmg.storyboard-manifest.v1.1`

The canonical reviewed pre-production graph. Per target it contains:

- profile and target metadata;
- ordered shot plans and timing;
- verified copy intent;
- FLUX prompt and generated-frame SHA evidence;
- deterministic composition plan;
- composed-frame SHA evidence;
- title/end visual plates;
- review-only governance.

### `tmg.video-render-plan.v1`

The future paid-renderer handoff. It references only composed frame object keys/SHAs and card object keys/SHAs from the immutable StoryboardManifest.

### `tmg.storyboard-brand-review-package.v1.1`

A concise human-review handoff linking the enhanced ImageAssetManifest, StoryboardManifest, and VideoRenderPlan while retaining publication/distribution authority as false.

## R2 key layout

```text
tenants/{tenantId}/image-runtime/{requestId}/
  control/
    image-asset-manifest-v1.json
    image-asset-manifest-v1.1.json
  inputs/
    ... authorized source/logo objects ...
  derivatives/
    ... authorized Image Runtime derivatives ...

tenants/{tenantId}/production-requests/{requestId}/
  marketing/
    creative-brief-v1.json
  outputs/marketing/storyboard-brand-v1-1/
    control/
      storyboard-manifest-v1.1.json
    targets/{variantId}/
      shots/{shotId}/
        generated.jpg|png
        composed.webp
      cards/
        title.webp
        end.webp
    handoff/
      video-render-plan-v1.json
    review/
      storyboard-brand-review-package-v1.1.json
```

All paths are tenant-scoped. Cross-tenant object references are not valid inputs.

## Governance invariants

1. Crawl/discovery authorization never implies exact asset reuse authorization.
2. Only an accepted ImageAssetManifest may supply exact brand assets.
3. Exact asset bytes are SHA-verified immediately before deterministic composition.
4. FLUX concept generation cannot reproduce exact logos/product screenshots by design.
5. Every generated/composed/card/motion artifact requires human review.
6. No storyboard artifact grants publication or external-distribution authority.
7. VideoRenderPlan creation does not authorize P-Video execution.
8. Immutable R2 keys may be reused only when all identity/provenance metadata match.
9. No cross-tenant asset reuse is permitted.
10. Production topology is unchanged by this increment.

## Isolated acceptance

The v1.1 canary starts from synthetic but explicitly rights-cleared canonical `ImageAssetManifest v1` and `MarketingCreativeBrief v1` fixtures. Those dependencies are already live-proven by the stacked baseline; the v1.1 canary isolates the new behavior.

The canary must prove:

1. exact-head typecheck/tests are green;
2. one isolated private R2 bucket and standalone Worker/Workflow are provisioned;
3. v1 ImageAssetManifest is projected into v1.1 with source-manifest SHA lineage;
4. three targets produce a `3 / 4 / 3` shot topology (10 shots total);
5. all 10 shots execute real FLUX inference;
6. all 10 generated frames are SHA-bound and image-signature verified;
7. all 10 frames receive deterministic exact approved-logo composition;
8. product/feature shots receive only authorized target derivatives;
9. each target gets title and end visual plates with exact approved logo;
10. immutable StoryboardManifest, VideoRenderPlan, and review package are persisted;
11. three deterministic H.264 multi-shot review mockups are compiled and verified;
12. P-Video execution authority remains false;
13. evidence is uploaded;
14. standalone Worker and every temporary R2 object/bucket are removed successfully.

The acceptance status must remain red if any real generated/composed artifact is absent, if provenance differs, if governance is weakened, or if teardown fails.

## Non-goals

v1.1 does not include:

- actual P-Video inference;
- production activation;
- publication or social distribution;
- cross-tenant asset reuse;
- reuse of candidate-only Firecrawl images;
- generative recreation of exact logos or screenshots;
- generative image editing;
- autonomous approval of creative claims.
