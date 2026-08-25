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
- `src/storyboard-brand-composition-entrypoint.ts` — ES-module Worker entrypoint for isolated deployment.
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

Contains request/tenant identity, immutable creative and ImageAssetManifest references, three target shot boards, three shots per target (`hook`, `product_value`, `cta`), exact timing, raw/composed SHA evidence, exact approved-logo SHA evidence, title/end-card specs, rights evidence and review-only governance.

### `tmg.video-render-plan.v1`

Contains the immutable StoryboardManifest reference, target profiles, shot timing/prompts, composed-frame keys/SHA-256 references and a future provider handoff to `pruna/p-video`. It is fail-closed with `executionState=disabled_pending_provider_capacity`, `storyboardGroundingRequired=true`, and `paidProviderExecutionAuthorized=false`.

## ImageAssetManifest dependency

Only accepted `tmg.image-asset-manifest.v1` records are allowed. Tenant must match; rights must be verified for `marketing_creative`; source reuse and logo overlay must be authorized; the approved-logo SHA must be valid; and human-review/publication/distribution gates must remain review-only. The logo object is fetched and re-hashed immediately before composition.

## Multi-shot planning

Every target receives three shots: hook, product value and CTA. Durations sum exactly to the target duration. FLUX prompts prohibit generated typography, exact logos, screenshots/UI, exact discovered assets and unsupported claims. Rights-cleared image derivatives can be referenced as supporting visual evidence, but FLUX is told not to recreate or imitate them.

## Generation and composition boundary

Workers AI model: `@cf/black-forest-labs/flux-1-schnell`, four diffusion steps. Raw JPEG/PNG frames are SHA-bound and private. Cloudflare Images then resizes/crops the generated frame and overlays the independently re-hashed approved-logo bytes at full opacity. Composed WebPs record output SHA, raw-frame SHA, exact-logo SHA and rights evidence.

## R2 keys

Root:
`tenants/{tenantId}/production-requests/{requestId}/storyboard-v1-1/`

Control:
- `control/storyboard-manifest-v1.1.json`
- `control/video-render-plan-v1.json`

Shots:
- `{targetProfileId}/shots/{shotId}/raw.jpg|png`
- `{targetProfileId}/shots/{shotId}/composed.webp`

Image rights authority remains under:
`tenants/{tenantId}/image-runtime/{imageRequestId}/control/image-asset-manifest-v1.json`

## Title/end cards and motion mockups

The manifest contains title/end-card specs using the first/last composed shots and exact approved-logo reference. Acceptance renders deterministic PNG review cards and three H.264 MP4 mockups: TikTok 9:16 / 7s, YouTube Shorts 9:16 / 8s, and Website Hero 16:9 / 6s. ffprobe verifies codec, dimensions and duration. These are review mockups, not P-Video outputs.

## Acceptance

The isolated acceptance proves exact-head validation; temporary R2; isolated Firecrawl and AI+Images Workers/Workflows; a synthetic rights-cleared ImageAssetManifest; real generation of 9 FLUX raw shots; real exact-logo composition of 9 WebPs; SHA/rights/authority verification; immutable StoryboardManifest and VideoRenderPlan; 3 title cards, 3 end cards and 3 H.264 motion mockups; sanitized evidence; and complete Worker/R2 teardown.

### Accepted implementation

- Head: `fadd21e69855ad12377f2cfa844ab54d9acd11c2`
- Quality: PASS — run `32880977790`
- Storyboard Brand Composition v1.1 acceptance: PASS — run `32880977821`
- Evidence artifact: `tmg-storyboard-brand-v11-32880977821`
- Artifact digest: `sha256:0f54e1cc18ecfdf063877fd6b65c1e140e5df4669f1cdf41fe7ef7086453cceb`
- Verified outputs: 9 multi-shot FLUX frames, 9 exact-logo Cloudflare Images compositions, 3 title cards, 3 end cards, 3 H.264 target motion mockups, immutable StoryboardManifest v1.1 and immutable VideoRenderPlan v1.
- Teardown: both temporary Workers and all temporary R2 objects/bucket deleted successfully.
- `paidProviderExecutionAuthorized=false`, `publicationAuthority=false`, `externalDistributionAuthority=false` throughout.

## Governance invariants

Crawl authority is separate from asset-reuse authority. ImageAssetManifest is the visual-rights authority. Tenant scopes cannot cross. Exact logos come only from approved bytes and are re-hashed immediately before composition. Generated/composed/card/mockup artifacts remain review-only. VideoRenderPlan cannot authorize P-Video execution. Human review is mandatory. No production activation, public processing endpoint, automated distribution, approval bypass, or customer media in CI is introduced.

## PR scope

Included: multi-shot planning; governed FLUX generation; exact rights-cleared logo composition; immutable StoryboardManifest; deterministic title/end-card specs/rendering; target-specific motion mockups; immutable P-Video handoff with paid execution disabled; isolated acceptance and teardown evidence.

Excluded: production activation; public storyboard endpoints; automated publication/distribution; P-Video execution; generative recreation/editing of approved logos/customer assets; approval bypasses.
