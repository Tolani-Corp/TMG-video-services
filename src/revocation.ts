import type { RightsRegistryRecord } from "./ingestion";

export interface IndexReceipt {
  schemaVersion: "1.0.0";
  tenantId: string;
  assetId: string;
  rightsProfileId: string;
  embeddingProfileId: string;
  vectorIds: string[];
  mutationId: string;
  indexedAt: string;
  status: "indexed" | "revoked";
  revokedAt?: string;
  revokeMutationId?: string;
}

export interface RevocationRequest {
  reason: string;
  revokedAt: string;
}

export interface VectorDeletionPort {
  deleteByIds(ids: string[]): Promise<{ mutationId: string }>;
}

export class RevocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevocationError";
  }
}

export function revokeRightsRecord(
  current: RightsRegistryRecord,
  request: RevocationRequest,
): RightsRegistryRecord {
  if (!request.reason.trim()) {
    throw new RevocationError("revocation reason is required");
  }
  if (!Number.isFinite(Date.parse(request.revokedAt))) {
    throw new RevocationError("revokedAt must be a valid timestamp");
  }

  return {
    ...current,
    evidenceState: "revoked",
    grants: {
      externalApi: false,
      mcp: false,
      advertising: false,
      datasetExport: false,
      licensing: false,
    },
    revision: current.revision + 1,
    updatedAt: request.revokedAt,
    revokedAt: request.revokedAt,
    revocationReason: request.reason,
  };
}

export function assertReceiptMatchesRights(
  receipt: IndexReceipt,
  rights: RightsRegistryRecord,
): void {
  if (receipt.tenantId !== rights.tenantId) throw new RevocationError("tenant mismatch");
  if (receipt.assetId !== rights.assetId) throw new RevocationError("asset mismatch");
  if (receipt.rightsProfileId !== rights.rightsProfileId) {
    throw new RevocationError("rights profile mismatch");
  }
}

export async function deleteIndexedVectorsForRevocation(
  index: VectorDeletionPort,
  receipt: IndexReceipt,
  rights: RightsRegistryRecord,
  revokedAt: string,
): Promise<IndexReceipt> {
  assertReceiptMatchesRights(receipt, rights);
  if (receipt.vectorIds.length === 0) {
    throw new RevocationError("index receipt contains no vectors");
  }

  const deletion = await index.deleteByIds(receipt.vectorIds);
  return {
    ...receipt,
    status: "revoked",
    revokedAt,
    revokeMutationId: deletion.mutationId,
  };
}
