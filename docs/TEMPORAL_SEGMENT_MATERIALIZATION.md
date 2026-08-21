# Governed Temporal Segment Materialization v1

This plane turns a longer canonical R2 video into immutable 4–30 second child MP4 assets that can be evaluated by the existing Marengo development-shadow workflow without changing authoritative provider routing.

## Authority boundary

- Manual GitHub `workflow_dispatch` only, `development` environment only.
- Requires canonical manifest, exact R2 SHA-256/byte evidence, and the current verified rights revision.
- Parent assets in `blocked`, expired, revoked, rejected, or pending rights states fail closed.
- Derived child manifests are always `publicationState=review`.
- Rights grants are inherited without expansion; Marengo shadow vector metadata still forces all external/commercial grants false.
- `fixture` remains the authoritative embedding provider and runtime external egress remains disabled.
- Shadow evaluation is opt-in per materialization run and defaults to false.

## Lineage

Each child receives a deterministic asset ID and its own canonical manifest, rights snapshot/current pointer, media SHA-256, and `temporal-segment-v1` derivation record. The derivation binds the child to the exact parent asset, parent media SHA, parent rights profile/revision, segment ID, and `[startMs,endMs)` window.

The parent receives a plan index under `control/temporal-segments/<planId>.json`. This is evidence and orchestration metadata only; it grants no publication authority.

## Rights freshness

Canonical ingestion now writes `control/rights/<profile>/current.json`; revocation advances the pointer. Shadow evaluation requires the selected rights revision to equal that current pointer. For a derived child it additionally requires the parent current pointer to still equal the parent rights revision captured at materialization. Any parent rights revision change invalidates new child evaluation until the child is rematerialized. Revocation of an already-created shadow vector remains deletion-only and is not blocked by a later rights-state change.

## Media transformation

GitHub's Ubuntu runner installs FFmpeg explicitly. The materializer downloads the parent object from private R2, verifies its exact bytes, and re-encodes each window to H.264/yuv420p MP4 with AAC when the source contains audio. Output bytes are hashed after encoding and those measured values become canonical child evidence.

v1 caps a source object at 1 GiB and a run at 64 non-overlapping windows. Segment outputs are 4–30 seconds to remain inside the accepted Marengo shadow profile.
