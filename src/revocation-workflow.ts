import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { z } from "zod";
import {
  rightsRegistryRecordSchema,
  type RightsRegistryRecord,
} from "./ingestion";
import {
  deleteIndexedVectorsForRevocation,
  revokeRightsRecord,
  type IndexReceipt,
} from "./revocation";

const requestSchema = z.object({
  tenantId: z.string().min(1).max(128),
  assetId: z.string().min(1).max(128),
  rightsProfileId: z.string().min(1).max(128),
  rightsRevision: z.number().int().positive(),
  embeddingProfileId: z.string().min(1).max(128),
  reason: z.string().min(1).max(2048),
});

const receiptSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  tenantId: z.string().min(1),
  assetId: z.string().min(1),
  rightsProfileId: z.string().min(1),
  embeddingProfileId: z.string().min(1),
  vectorIds: z.array(z.string().min(1)).min(1),
  mutationId: z.string().min(1),
  indexedAt: z.string().min(1),
  status: z.enum(["indexed", "revoked"]),
  revokedAt: z.string().optional(),
  revokeMutationId: z.string().optional(),
});

type RevocationWorkflowRequest = z.infer<typeof requestSchema>;

interface RevocationWorkflowResult {
  status: "revoked";
  assetId: string;
  rightsRevision: number;
  deletedVectorCount: number;
  deletionMutationId: string;
  receiptKey: string;
  revocationEventKey: string;
}

async function readJson<T>(
  bucket: R2Bucket,
  key: string,
  parse: (input: unknown) => T,
): Promise<T> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`required R2 control object not found: ${key}`);
  const text = await object.text();
  return parse(JSON.parse(text) as unknown);
}

async function putJson(bucket: R2Bucket, key: string, value: unknown): Promise<void> {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
  });
}

function assetRoot(request: RevocationWorkflowRequest): string {
  return `tenants/${request.tenantId}/assets/${request.assetId}`;
}

export class RevocationWorkflow extends WorkflowEntrypoint<Env, unknown> {
  async run(
    event: WorkflowEvent<unknown>,
    step: WorkflowStep,
  ): Promise<RevocationWorkflowResult> {
    const request = await step.do("validate revocation request", async () =>
      requestSchema.parse(event.payload),
    );
    const root = assetRoot(request);
    const rightsKey =
      `${root}/control/rights/${request.rightsProfileId}/r${request.rightsRevision}.json`;
    const receiptKey =
      `${root}/control/index-receipts/${request.embeddingProfileId}.json`;
    const revocationEventKey = `${root}/events/revocation/${event.instanceId}.json`;

    const currentRights = await step.do("load current rights revision", async () =>
      readJson<RightsRegistryRecord>(
        this.env.MEDIA_BUCKET,
        rightsKey,
        (input) => rightsRegistryRecordSchema.parse(input),
      ),
    );

    if (currentRights.evidenceState === "revoked" || currentRights.revokedAt) {
      throw new Error("rights record is already revoked");
    }

    const receipt = await step.do("load index receipt", async () =>
      readJson<IndexReceipt>(
        this.env.MEDIA_BUCKET,
        receiptKey,
        (input) => receiptSchema.parse(input) as IndexReceipt,
      ),
    );

    if (receipt.status !== "indexed") {
      throw new Error(`index receipt is not active: ${receipt.status}`);
    }

    const revokedAt = event.timestamp.toISOString();
    const revokedRights = revokeRightsRecord(currentRights, {
      reason: request.reason,
      revokedAt,
    });
    const revokedRightsKey =
      `${root}/control/rights/${request.rightsProfileId}/r${revokedRights.revision}.json`;

    await step.do("persist revoked rights revision", async () => {
      await putJson(this.env.MEDIA_BUCKET, revokedRightsKey, revokedRights);
    });

    const revokedReceipt = await step.do(
      "delete semantic vectors",
      { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
      async () =>
        deleteIndexedVectorsForRevocation(
          {
            deleteByIds: async (ids) => {
              const mutation = await this.env.VIDEO_INDEX.deleteByIds(ids);
              return { mutationId: mutation.mutationId };
            },
          },
          receipt,
          revokedRights,
          revokedAt,
        ),
    );

    await step.do("persist revocation evidence", async () => {
      await Promise.all([
        putJson(this.env.MEDIA_BUCKET, receiptKey, revokedReceipt),
        putJson(this.env.MEDIA_BUCKET, revocationEventKey, {
          schemaVersion: "1.0.0",
          assetId: request.assetId,
          tenantId: request.tenantId,
          rightsProfileId: request.rightsProfileId,
          previousRightsRevision: request.rightsRevision,
          revokedRightsRevision: revokedRights.revision,
          deletedVectorIds: receipt.vectorIds,
          deletionMutationId: revokedReceipt.revokeMutationId,
          reason: request.reason,
          revokedAt,
        }),
      ]);
    });

    if (!revokedReceipt.revokeMutationId) {
      throw new Error("Vectorize deletion did not return a mutation id");
    }

    return {
      status: "revoked",
      assetId: request.assetId,
      rightsRevision: revokedRights.revision,
      deletedVectorCount: receipt.vectorIds.length,
      deletionMutationId: revokedReceipt.revokeMutationId,
      receiptKey,
      revocationEventKey,
    };
  }
}
