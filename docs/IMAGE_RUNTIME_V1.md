# TMG Image Runtime v1

TMG Image Runtime v1 is a deterministic, rights-gated image processing plane. It does **not** generate synthetic imagery and it does not grant publication or external-distribution authority.

## Scope

The v1 path is intentionally narrow:

`authorized private R2 image + approved private R2 logo -> SHA-256 binding -> Cloudflare Images technical inspection -> rights gate -> deterministic transform/composition -> private R2 derivatives -> immutable ImageAssetManifest -> campaign review package`

Production remains frozen. The Images binding and `ImageProcessingWorkflow` are enabled only in development/isolated acceptance configuration until a separate production-adoption gate is approved.

## Authority model

An image-processing request must provide separate authority for the source image and logo:

- source object is tenant-scoped and includes an expected SHA-256, MIME type, authority reference, and `reuseAuthorized=true`;
- logo object is tenant-scoped and includes an expected SHA-256, MIME type, authority reference, and `overlayAuthorized=true`;
- rights evidence must be explicitly marked `verified` for `marketing_creative` use;
- human review remains mandatory;
- publication authority and external-distribution authority are always false.

The runtime has no public image-processing HTTP endpoint. `ImageProcessingWorkflow` is an internal Cloudflare Workflow binding. A future public or product-facing intake adapter must resolve canonical rights evidence upstream before it is allowed to construct this internal request contract.

## Integrity and technical inspection

Before any transform, the Workflow:

1. fetches source and logo from private R2;
2. enforces Cloudflare Images' 20 MiB binding input boundary;
3. computes SHA-256 and requires byte-identical match with the authorized request;
4. decodes each object with the Cloudflare Images binding `info()` operation;
5. verifies decoded dimensions and byte count;
6. verifies the decoded format matches the authorized MIME declaration;
7. re-reads and re-hashes both assets immediately before composition so a post-inspection object mutation fails closed.

Allowed v1 source formats are PNG, JPEG, and WebP. Exact logo overlays are restricted to PNG and WebP.

## Deterministic target profiles

| Preset | Output | Aspect | Format |
| --- | ---: | ---: | --- |
| `tiktok.cover.v1` | 1080 x 1920 | 9:16 | WebP |
| `youtube.thumbnail.v1` | 1280 x 720 | 16:9 | WebP |
| `instagram.square.v1` | 1080 x 1080 | 1:1 | WebP |
| `web.hero.v1` | 1600 x 900 | 16:9 | WebP |

The source image uses deterministic `cover` fitting. The separately authorized logo is resized proportionally and composited exactly in the lower-right safe inset. No generative model redraws or approximates the logo.

## Immutable derivative contract

Derivatives are stored under:

`tenants/{tenantId}/image-runtime/{requestId}/derivatives/{presetId}.webp`

Each derivative records source SHA-256, logo SHA-256, output SHA-256, preset ID, rights evidence reference, review requirement, and publication state in R2 metadata.

Workflow retries reuse an existing derivative only when its immutable metadata matches the current authorized source hash, logo hash, preset, and rights evidence reference. Any mismatch is an immutable-artifact conflict and fails closed.

## ImageAssetManifest

`tmg.image-asset-manifest.v1` records:

- request and tenant identity;
- source R2 identity, SHA-256, bytes, MIME, authority reference, decoded technical inspection;
- approved-logo R2 identity, SHA-256, bytes, MIME, authority reference, decoded technical inspection;
- verified marketing-use rights reference;
- every target derivative and its cryptographic evidence;
- Cloudflare Images / R2 processing provenance;
- mandatory human review and zero publication/distribution authority.

The companion `tmg.image-campaign-review-package.v1` is the handoff object for downstream human review.

## Acceptance

The isolated development canary provisions a temporary R2 bucket and Worker/Workflow, uploads deterministic synthetic source/logo fixtures, binds their exact hashes into the request, runs the real Cloudflare Images binding, retrieves all four WebP derivatives plus the manifest/review package, verifies cryptographic and format evidence, uploads sanitized evidence only, and tears down the temporary resources.

No customer imagery and no generated image binaries are retained in GitHub Actions evidence.

## Explicitly deferred

### v1.1 — storyboard / keyframe runtime

A later increment may use accepted image assets to create deterministic storyboard boards, keyframe references, title/end cards, and video shot-plan inputs. This remains outside v1.

### v2 — generative image creation/editing

Generative image creation and semantic editing require a separately accepted AI provider, provider-specific safety/rights policy, explicit egress authority, spend controls, provenance, and human review. Generative output must not inherit the stronger authority of deterministic transformations.
