# Marengo Shadow Evaluation Plane v1

This plane operationalizes the accepted TwelveLabs Marengo 3.0 provider only for **manual development shadow evaluation**. It does not participate in authoritative ingestion, public search, MCP, advertising, dataset export, licensing, or publication.

## Authority boundary

- `fixture` remains the default and only authoritative embedding provider.
- `config/model-compatibility-registry.json` keeps `twelvelabs-marengo3` in `shadow` status and keeps external provider egress disabled.
- `config/provider-acceptance-registry.json` records the immutable development acceptance evidence but explicitly grants no routing or commercial authority.
- Shadow vectors are stored only in the dedicated `tmg-marengo-shadow-eval-512-dev` Vectorize index.
- Shadow vector metadata forcibly sets `publicationState=review` and all external/commercial grants to `false`, regardless of the source asset's broader rights envelope.
- The temporary TwelveLabs asset is deleted after embedding generation, including partial-failure cleanup paths.

## Manual workflow

`.github/workflows/marengo-shadow-evaluation.yml` is `workflow_dispatch` only and uses the `development` GitHub Environment. The operator supplies the canonical tenant, asset, rights profile, rights revision, and chooses `evaluate` or `revoke`.

For evaluation, the workflow:

1. Reads canonical manifest and rights evidence from the private development R2 bucket.
2. Validates tenant/asset/rights binding, verified and unexpired rights, allowed tenant, media SHA-256, 4–30 second duration, MP4 content type, and a 25 MiB memory-safety cap.
3. Ensures the isolated 512-d cosine Vectorize index and the eight governance metadata indexes exist before any vector is inserted.
4. Downloads the exact media bytes from R2 and re-verifies SHA-256 and byte count.
5. Direct-uploads those bytes to a temporary TwelveLabs asset, waits for `ready`, creates one Marengo 3.0 fused 512-d asset embedding, and deletes the provider asset.
6. Upserts one deterministic shadow vector into the dedicated index and verifies it by exact vector ID.
7. Writes the shadow index receipt and evaluation event back to R2.

For revocation, the workflow reads the canonical shadow receipt, deletes the exact vector ID, proves it is absent, and stores a revocation event in R2. Revocation remains permitted when the source rights have since expired or been revoked so stale semantic material can always be removed.

## Promotion gate

A successful shadow evaluation does not promote Marengo. Authoritative routing requires a separate release decision, a non-G0 product status, explicit runtime egress authorization, production secrets/bindings, quota/cost controls, abuse controls, and a production acceptance window.
