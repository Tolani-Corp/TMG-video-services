# Architecture

## Status

TMG Video Services is a **G0 internal prototype**. Its architecture may be exercised in development, but no public API, MCP endpoint, advertising product, dataset exchange, or licensing service is authorized as commercially live.

## Authority hierarchy

1. `Tolani-Corp/TolaniCorp-HQ/config/portfolio-commercial-registry.json`
2. `Tolani-Corp/TolaniCorp-HQ/docs/PUBLIC_CONTENT_GOVERNANCE.md`
3. This repository's `config/public-product-context.json`
4. This repository's `config/retrieval-policy.json`
5. Canonical per-asset rights evidence
6. Derived vector metadata and indexes

Lower layers may specialize higher-level rules but may not contradict them.

## Core design

```text
Authorized media source
        |
        v
Canonical asset + provenance manifest
        |
        v
Rights evidence / purpose grants
        |
        v
Temporal segmentation
        |
        v
Embedding provider adapter
        |
        +----------------------+
        |                      |
        v                      v
R2 canonical artifacts    Vectorize projection
                               |
                               v
                   coarse rights/tenant filter
                               |
                               v
                      policy decision engine
                               |
                 +-------------+-------------+
                 |                           |
                 v                           v
           REST retrieval                MCP tools
          (disabled at G0)             (disabled at G0)
```

## Control-plane versus data-plane ownership

### Canonical control plane

The canonical control plane owns:

- source identity and provenance;
- rights evidence and expiration;
- tenant and territory scope;
- publication state;
- purpose-specific grants;
- embedding model/version lineage;
- review/audit evidence.

Vector metadata is an **enforcement projection**, never the canonical source of rights authority.

### Retrieval data plane

Cloudflare Vectorize holds temporal segment embeddings and a bounded metadata projection needed to efficiently restrict candidate search. Each vector must point back to canonical asset, segment, rights profile, and embedding profile identifiers.

The current v1 projection is designed for a 512-dimension embedding profile. Different embedding dimensions or incompatible model families require separate indexes and explicit migration/versioning rather than silent mixing.

## MCP architecture

The repository uses the current stateless MCP server path:

- MCP SDK v2 (`@modelcontextprotocol/server`);
- Cloudflare Agents SDK `createMcpHandler()`;
- Streamable HTTP at `/mcp`;
- `legacy: "reject"` for a clean 2026-07-28 protocol boundary;
- fresh MCP server instances per request;
- no session state or Durable Object dependency in v1.

MCP is disabled by configuration at G0.

## Retrieval invariant

A query is never authorized solely because a vector is semantically similar.

External retrieval requires all of the following:

1. verified rights evidence;
2. approved publication state;
3. matching tenant scope;
4. matching territory where applicable;
5. unexpired rights;
6. an explicit grant for the requested purpose (`external_api`, `mcp`, `advertising`, `dataset_export`, or `licensing`).

## Async processing boundary

Future ingestion, transcription, shot detection, embedding generation, rights reconciliation, and re-indexing should run through Queues or Workflows rather than the synchronous request path. Public API requests should remain bounded retrieval operations.

## Planned services

- ingestion control plane;
- embedding-provider abstraction;
- R2 canonical manifest store;
- Vectorize segment index;
- rights/provenance registry;
- REST developer API;
- MCP gateway;
- usage/billing telemetry;
- contextual advertising signals;
- dataset packaging and licensing controls.

Only the retrieval kernel and governance skeleton are implemented in v1.
