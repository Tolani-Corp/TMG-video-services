# Derived Rights Cascade & Shadow Revocation v1

This development-only control plane closes the stale-derived-vector gap after temporal materialization.

A cascade is allowed only when the parent's current rights revision or evidence state differs from the immutable parent rights snapshot recorded by the selected temporal materialization plan. The dispatcher must name that exact `plan_id`; the workflow does not guess the latest plan and does not list arbitrary R2 prefixes to discover children.

For every child in the immutable plan, the cascade revalidates child manifest/media lineage, current rights pointer, and rights revision. If child rights are still active, a new revoked revision is written first with every external/commercial grant forced false and `current.json` advanced to the revoked revision. Only after that fail-closed rights write may an existing `indexed_shadow` receipt cause exact `delete_by_ids()` cleanup in the Marengo development Vectorize index.

The operation is idempotent. Already-revoked children remain revoked; an accidentally still-active shadow vector can still be deleted. Missing or already-revoked shadow receipts require no vector mutation.

The cascade never deletes R2 parent media, child media, manifests, rights history, derivation lineage, or materialization plans. It grants no publication, REST, MCP, advertising, dataset-export, licensing, or authoritative provider authority.
