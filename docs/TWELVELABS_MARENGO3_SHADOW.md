# TwelveLabs Marengo 3.0 Shadow Adapter v1

## Status

G0 / non-authoritative shadow implementation.

This increment registers Marengo 3.0 as a real external provider contract without granting it authoritative indexing, public API, MCP, advertising, licensing, dataset-export, or publication authority.

The provider registry state is intentionally:

```text
providerId: twelvelabs-marengo3
status: shadow
egressClass: external
acceptanceRequirement: development_acceptance
profile: twelvelabs_marengo3_fused_512_v1
compatibilityGroup: marengo3_fused_512_v1
vectorIndexBinding: MARENGO_VIDEO_INDEX (reserved; not provisioned by this increment)
```

Repository defaults remain:

```text
TMG_EMBEDDING_PROVIDER_ID=fixture
TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED=false
TMG_PROVIDER_ACCEPTANCE_STATE=unverified
TMG_PUBLIC_API_ENABLED=false
TMG_MCP_ENABLED=false
```

## Why Marengo uses a separate compatibility group

Marengo 3.0 and the deterministic fixture provider both emit 512-dimensional vectors, but equal dimensionality does not make two semantic spaces compatible.

The fixture vectors exist only to prove TMG ingestion, metadata filtering, retrieval, and revocation mechanics. Marengo vectors encode learned multimodal semantics. They must never be inserted into the same Vectorize index or compared as if they shared a latent space.

`marengo3_fused_512_v1` therefore reserves a separate index contract. Provisioning that index is a later development-environment action after the shadow egress gate is approved.

## Current TwelveLabs contract

The adapter targets the first-party TwelveLabs Embed API v2 synchronous endpoint:

```text
POST https://api.twelvelabs.io/v1.3/embed-v2
model_name=marengo3.0
input_type=video
```

For the first shadow increment, TMG requests:

```text
embedding_option=[visual,audio,transcription]
embedding_type=[fused_embedding]
embedding_scope=[asset]
```

The governed `start_sec` / `end_sec` window maps one TMG segment to one fused asset-scope vector. The adapter restricts shadow probes to 4-30 second clip windows to keep this one-vector contract bounded and reviewable.

The broader provider supports synchronous video below ten minutes and asynchronous video up to four hours. The async Embed API stores embedding task results for seven days. TMG does not use that async path in this increment.

## Egress boundary

The current canonical media reference produced by the ingestion workflow is private `r2://...` state. The shadow adapter deliberately rejects `r2://`, HTTP, local-file, and other non-HTTPS references before any external request.

A shadow request requires an explicitly authorized direct HTTPS media URL. TMG does not create such URLs in this increment.

This means the adapter is testable against mocked transport but cannot accidentally exfiltrate canonical private R2 media.

A future egress bridge must separately define:

1. the rights state required before provider egress;
2. the exact object/segment allowed to leave TMG;
3. a short-lived delivery mechanism or direct upload path;
4. provider retention/deletion expectations;
5. audit evidence linking the rights revision to the provider request;
6. cost/quota limits;
7. a dedicated `MARENGO_VIDEO_INDEX` lifecycle and revocation test.

## Secret handling

No TwelveLabs key is committed, declared as a non-secret Wrangler variable, or deployed by this increment.

When a controlled development shadow probe is later authorized, use a Cloudflare Worker secret such as `TWELVELABS_API_KEY`. The secret must be supplied through the Worker environment at execution time and must never be included in logs, errors, provider usage evidence, or persisted control records.

## Fail-closed behavior

The shadow adapter rejects or fails on:

- missing API credentials;
- non-HTTPS media references;
- clip windows shorter than 4 seconds or longer than 30 seconds;
- HTTP errors from TwelveLabs;
- malformed response bodies;
- missing or multiple fused asset embeddings;
- vectors that are not exactly 512 dimensions;
- request timeout.

Provider HTTP error handling records only the status code. It does not echo the upstream response body or API key.

## Promotion gate

Do not connect this adapter to `EmbeddingProviderRouter` as an authoritative factory while its registry state is `shadow`.

The next promotion step is a **Development Shadow Egress Acceptance**, using one specifically authorized synthetic or first-party clip. That test must prove:

```text
rights/egress decision PASS
        ↓
short-lived authorized HTTPS source
        ↓
Marengo fused 512-d embedding
        ↓
dedicated Marengo Vectorize index
        ↓
semantic retrieval evidence
        ↓
provider usage/cost evidence
        ↓
revocation and index deletion
        ↓
provider/source cleanup evidence
```

Only after that evidence is green should TMG consider changing the provider from `shadow` to `enabled` for controlled development traffic. Public REST/MCP exposure is a separate gate.
