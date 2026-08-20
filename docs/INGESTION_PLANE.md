# TMG Video Ingestion & Multimodal Embedding Plane v1

## Status

G0 / internal prototype. The workflow is disabled by default and accepts only the repository-owned harmless fixture when enabled for controlled validation.

## Control flow

```text
operator-triggered Workflow
        |
        v
canonical manifest + rights revision
        |
        +--> persist control records to private R2
        |
        v
physical evidence check
  object exists
  byte count matches
  SHA-256 matches
        |
        v
rights state evaluation
  verified only
        |
        v
fixture-only temporal embedding provider
        |
        v
prepareVectorUpsert()
  lineage + rights metadata
        |
        v
Vectorize upsert
        |
        v
immutable-ish index receipt in R2
```

A failed physical-evidence or rights check is a **quarantine outcome**, not a publication action and not a workflow failure.

## Harmless fixture

`fixtures/harmless/harmless-fixture.mp4` is a synthetic one-second, single-frame black H.264 MP4 with no audio. It contains no third-party media, people, brands, or copyrighted source footage.

The committed `control.json` binds the exact fixture bytes to:

- SHA-256 `479a18838b9914e6994725f3b8dc7e15bc07ffe80ab3b1c1805e195d0251f1e3`
- 1,441 bytes
- one one-second temporal segment
- `review` publication state
- verified fixture evidence only
- every external/commercial grant set to `false`

Run `pnpm fixture:verify` before any fixture upload.

## Controlled Cloudflare acceptance sequence

Do not run this against production resources.

1. Provision the development R2 bucket and 512-dimension cosine Vectorize index.
2. Create the eight metadata indexes documented in `ARCHITECTURE.md` before upserting vectors.
3. Upload the harmless fixture to:
   `tmg-video-assets-dev/tenants/tmg_fixture/assets/harmless_fixture_001/media/original.mp4`.
4. Set `TMG_INGEST_WORKFLOW_ENABLED=true` only in the controlled development environment.
5. Trigger `tmg-video-ingestion-dev` with the JSON object in `fixtures/harmless/control.json` as workflow params.
6. Inspect the Workflow result and R2 control records.
7. Confirm Vectorize contains exactly one fixture vector and that it remains `review`, `mcp=false`, and `externalApi=false`.
8. Confirm `/v1/search/vector` and `/mcp` remain disabled independently.
9. Return `TMG_INGEST_WORKFLOW_ENABLED=false` after the acceptance run.

Wrangler currently supports direct R2 object upload with:

```bash
pnpm wrangler r2 object put \
  tmg-video-assets-dev/tenants/tmg_fixture/assets/harmless_fixture_001/media/original.mp4 \
  --file fixtures/harmless/harmless-fixture.mp4 \
  --content-type video/mp4 \
  --remote
```

For fixture objects only, if R2 does not expose a stored SHA-256 checksum, the Workflow may read and hash the object when it is at or below the hard 1 MB fixture fallback limit. Production media must not use this bounded fixture fallback.

## Provider boundary

The current provider is deterministic and fixture-only. It proves the interface and index lineage without sending media to an external model provider.

The first external video-native adapter should target TwelveLabs Embed API v2 / Marengo 3.0 behind a provider interface. Marengo 3.0 emits 512-dimensional embeddings and supports video/audio/image/text in a shared space, but live provider activation requires a separate secret, data-egress, retention, rights, and cost review.

Do not make the provider name part of business truth. `EmbeddingProfile` and `compatibilityGroup` are the stable internal contract.

## Revocation

Each successful index operation writes an `IndexReceipt` containing every vector ID. Revocation must:

1. create a new rights revision with `evidenceState=revoked`;
2. set every external/commercial grant to false;
3. call the bound Vectorize index `deleteByIds()` for every ID in the receipt;
4. persist the returned asynchronous deletion mutation ID;
5. keep the source media and evidence records quarantined for audit unless a separate retention policy requires deletion.

Deletion from the semantic index is therefore independent from media retention and independent from publication state.
