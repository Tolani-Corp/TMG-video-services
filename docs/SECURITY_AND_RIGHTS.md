# Security, Rights, and Commercialization Boundaries

## Non-negotiable rules

1. **Vectorization does not create rights.** Every derived embedding inherits the restrictions of its source asset and may be subject to additional restrictions.
2. **External use is deny-by-default.** Similarity alone never authorizes API, MCP, advertising, dataset-export, licensing, streaming, or publication use.
3. **Rights evidence stays canonical outside the vector index.** Vector metadata is only a query-time enforcement projection.
4. **Tenant isolation is mandatory.** Namespaces and tenant metadata are both used so an index configuration mistake does not become the sole isolation boundary.
5. **No secrets in source control.** Provider credentials and future API secrets must use Wrangler secrets or an approved secret store.
6. **No public activation at G0.** `TMG_PUBLIC_API_ENABLED` and `TMG_MCP_ENABLED` remain `false` until the portfolio status gate, authentication, abuse controls, billing controls, and release evidence are approved.

## Purpose grants

Each canonical rights profile can independently allow or deny:

- external API retrieval;
- MCP retrieval;
- contextual advertising use;
- dataset export/model-use packaging;
- licensing transactions.

A grant for one purpose is never interpreted as a grant for another.

## Publication state

- `internal` — internal processing/search only;
- `review` — under governance/rights review;
- `approved` — eligible for explicitly granted external purposes;
- `blocked` — excluded from all retrieval other than privileged administrative investigation not implemented in this repository.

## Pre-retrieval projection

Vectorize metadata should include the minimum fields needed to restrict candidate retrieval:

- `tenantId`;
- `rightsVerified`;
- `publicationState`;
- `externalApi`;
- `mcp`;
- `advertising`;
- `datasetExport`;
- `licensing`;
- canonical asset/segment/rights/embedding identifiers.

Tenant namespaces should be used in addition to metadata filters.

## Post-candidate decision

Before a result is released, the policy engine verifies additional conditions that are not safely represented as a single metadata predicate, including rights expiry and territory scope.

## Production prerequisites

Before either external flag can be enabled:

- register this repository in the canonical HoldCo portfolio registry;
- pass the appropriate public-status promotion review;
- place REST and MCP behind approved authentication/authorization;
- establish rate limits, quotas, abuse detection, and tenant billing identity;
- provision production R2 and Vectorize resources separately from development;
- configure metadata indexes before inserting vectors;
- create reproducible embedding lineage and re-index procedures;
- implement canonical rights/profile persistence and audit trails;
- implement deletion/revocation propagation from canonical assets through every derived vector;
- validate security, privacy, and rights behavior with adversarial tests;
- obtain explicit production release approval.

## Revocation rule

A rights revocation must propagate to derived artifacts. The target production design is:

`canonical revoke -> retrieval deny -> vector metadata/index update -> derivative invalidation -> audit event`

Retrieval deny should happen before asynchronous cleanup completes.
