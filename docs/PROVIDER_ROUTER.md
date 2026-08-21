# Provider Router + Model Compatibility Registry v1

## Status

G0 / internal prototype. The deterministic fixture provider is the only runnable provider. External provider egress remains disabled and no third-party model adapter is activated by this increment.

## Design principle

The stable contract is the **compatibility group**, not the vendor name.

A compatibility group fixes the vector shape and search contract used by an index:

- dimensions;
- distance metric;
- Vectorize binding;
- environment state.

A provider entry maps one concrete embedding profile into exactly one compatibility group. Changing model dimensions or semantic space therefore requires a new compatibility group/index migration instead of silently mixing incompatible vectors.

## Runtime gates

A provider may resolve only when all of these are true:

1. it is present in the registry;
2. its registry status is `enabled`;
3. its profile matches the compatibility-group dimensions;
4. a runtime adapter factory exists;
5. the adapter profile exactly matches the registry profile;
6. external egress is explicitly allowed by both registry and runtime policy when required;
7. development acceptance evidence is `passed` when the provider requires it.

At G0 the repository defaults are:

```text
TMG_EMBEDDING_PROVIDER_ID=fixture
TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED=false
TMG_PROVIDER_ACCEPTANCE_STATE=unverified
```

The commercial-integrity check fails if those defaults are relaxed while public status remains G0.

## Current registry

Only `fixture` is registered as runnable:

```text
provider: fixture
profile: fixture_video_512_v1
compatibility group: fixture_video_512
dimensions: 512
metric: cosine
egress: none
status: enabled
```

No TwelveLabs, Vertex, or other external adapter is active yet.

## Provider usage evidence

Every successful ingestion now writes a provider usage event beside the index receipt. The event records measured operational units rather than speculative pricing:

- provider ID;
- embedding profile;
- compatibility group;
- egress class;
- tenant and asset;
- segment count;
- media duration;
- input bytes;
- vector count;
- dimensions;
- timestamp.

This becomes the substrate for later cost accounting, quota enforcement, and billable usage without coupling commercial truth to a model vendor's temporary price sheet.

## Next promotion step

Do not register or activate a real external provider until Development Infrastructure Acceptance + Revocation E2E has produced durable evidence that:

- all metadata indexes exist before insertion;
- fixture ingest creates exactly one review-only vector;
- internal retrieval works;
- revocation deletes that vector;
- R2 evidence survives revocation;
- ingestion returns to disabled.

After that gate, add one external adapter as `disabled`, test it in shadow/non-authoritative mode with explicit egress and retention review, and only then consider enabling it for controlled development traffic.
