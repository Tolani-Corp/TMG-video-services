import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { DeterministicFixtureEmbeddingProvider } from "./fixture-provider";
import {
  buildArtifactKeys,
  buildVideoSegmentRecords,
  effectiveRightsEvidenceState,
  parseGovernedIngestionRequest,
  type GovernedIngestionRequest,
} from "./ingestion";
import { prepareVectorUpsert } from "./indexing";
import { verifyPhysicalMediaEvidence } from "./physical-evidence";
import type { IndexReceipt } from "./revocation";
import { requireVectorizeAsyncMutationId } from "./vector-mutation";

interface IngestionWorkflowResult {
  status: "disabled" | "quarantined" | "indexed";
  assetId?: string;
  reasons?: string[];
  mutationId?: string;
  vectorCount?: number;
  receiptKey?: string;
}

async function putJson(bucket: R2Bucket, key: string, value: unknown): Promise<void> {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
  });
}

export class IngestionWorkflow extends WorkflowEntrypoint<Env, unknown> {
  async run(
    event: WorkflowEvent<unknown>,
    step: WorkflowStep,
  ): Promise<IngestionWorkflowResult> {
    if (String(this.env.TMG_INGEST_WORKFLOW_ENABLED) !== "true") {
      return { status: "disabled", reasons: ["g0_ingestion_workflow_disabled"] };
    }

    const request = await step.do("validate control envelope", async () =>
      parseGovernedIngestionRequest(event.payload),
    );
    const nowIso = event.timestamp.toISOString();
    const keys = buildArtifactKeys(request.manifest, request.rights);

    await step.do("persist canonical manifest and rights revision", async () => {
      await Promise.all([
        putJson(this.env.MEDIA_BUCKET, keys.manifest, request.manifest),
        putJson(this.env.MEDIA_BUCKET, keys.rightsRevision, request.rights),
      ]);
    });

    if (request.manifest.source.sourceClass !== "fixture") {
      const reasons = ["g0_fixture_only_ingestion"];
      await step.do("record unsupported source quarantine", async () => {
        await putJson(this.env.MEDIA_BUCKET, keys.quarantineEvent(event.instanceId), {
          schemaVersion: "1.0.0",
          assetId: request.manifest.assetId,
          ingestRunId: request.manifest.ingestRunId,
          reasons,
          createdAt: nowIso,
        });
      });
      return { status: "quarantined", assetId: request.manifest.assetId, reasons };
    }

    const physicalEvidence = await step.do("verify physical media evidence", async () =>
      verifyPhysicalMediaEvidence(this.env.MEDIA_BUCKET, request.manifest),
    );

    const rightsState = effectiveRightsEvidenceState(request.rights, nowIso);
    const quarantineReasons = [...physicalEvidence.reasons];
    if (rightsState !== "verified") {
      quarantineReasons.push(`rights_${rightsState}`);
    }

    if (quarantineReasons.length > 0) {
      await step.do("persist quarantine event", async () => {
        await putJson(this.env.MEDIA_BUCKET, keys.quarantineEvent(event.instanceId), {
          schemaVersion: "1.0.0",
          assetId: request.manifest.assetId,
          ingestRunId: request.manifest.ingestRunId,
          reasons: quarantineReasons,
          physicalEvidence,
          rightsState,
          createdAt: nowIso,
        });
      });
      return {
        status: "quarantined",
        assetId: request.manifest.assetId,
        reasons: quarantineReasons,
      };
    }

    const dimensions = Number(this.env.TMG_EMBEDDING_DIMENSIONS);
    const provider = new DeterministicFixtureEmbeddingProvider(dimensions);
    const records = buildVideoSegmentRecords(
      request.manifest,
      request.rights,
      provider.profile,
      request.segments,
      nowIso,
    );

    const indexResult = await step.do(
      "generate deterministic fixture embeddings and index",
      { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
      async () => {
        const prepared = [];
        for (const record of records) {
          const vector = await provider.embedSegment({
            assetId: record.assetId,
            segmentId: record.segmentId,
            startMs: record.startMs,
            endMs: record.endMs,
            mediaRef: `r2://${request.manifest.media.objectKey}`,
          });
          prepared.push(await prepareVectorUpsert(record, provider.profile, vector));
        }

        const mutation = await this.env.VIDEO_INDEX.upsert(prepared);
        return {
          mutationId: requireVectorizeAsyncMutationId(mutation),
          vectorIds: prepared.map((vector) => vector.id),
          embeddingProfileId: provider.profile.id,
        };
      },
    );

    const receipt: IndexReceipt = {
      schemaVersion: "1.0.0",
      tenantId: request.manifest.tenantId,
      assetId: request.manifest.assetId,
      rightsProfileId: request.rights.rightsProfileId,
      embeddingProfileId: indexResult.embeddingProfileId,
      vectorIds: indexResult.vectorIds,
      mutationId: indexResult.mutationId,
      indexedAt: nowIso,
      status: "indexed",
    };
    const receiptKey = keys.indexReceipt(indexResult.embeddingProfileId);

    await step.do("persist index receipt", async () => {
      await putJson(this.env.MEDIA_BUCKET, receiptKey, receipt);
    });

    return {
      status: "indexed",
      assetId: request.manifest.assetId,
      mutationId: indexResult.mutationId,
      vectorCount: indexResult.vectorIds.length,
      receiptKey,
    };
  }
}

export type { GovernedIngestionRequest };
