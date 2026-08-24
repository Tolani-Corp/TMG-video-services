import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { compileCampaignContextManifest, type CampaignContextManifest } from "./campaign-context";
import {
  getMarketingCrawlSnapshot,
  startMarketingCrawl,
  type FirecrawlMarketingCrawlSnapshot,
} from "./firecrawl-marketing-runtime";
import { buildMarketingDiscoveryPlan } from "./marketing-context";
import {
  compileMarketingCreativeBrief,
  compileMarketingSocialCopy,
  type MarketingCreativeBrief,
} from "./marketing-creative";
import {
  generateMarketingVideoVariant,
  type MarketingReviewPackage,
  type MarketingVideoArtifact,
} from "./marketing-video-runtime";
import {
  marketingDiscoveryPlanObjectKey,
  productionPackageObjectKey,
  productionPlanObjectKey,
  type ProductionPlan,
} from "./production-request";

const MAX_PARALLEL_MARKETING_VIDEO_GENERATIONS = 3;

interface ProductionPackageManifest {
  schemaVersion: "tmg.production-package.v1";
  requestId: string;
  tenantId: string;
  status: "planned";
  productionPlanKey: string;
  marketingDiscoveryPlanKey?: string;
  distributionTargets: ProductionPlan["distributionTargets"];
  deliverables: Array<{
    type: string;
    skill: string;
    targets: ProductionPlan["distributionTargets"];
    status: "pending_skill_activation";
    artifacts: [];
  }>;
  publicationAuthority: false;
  externalDistributionAuthority: false;
  createdAt: string;
}

interface ProductionWorkflowResult {
  status: "planned" | "ready_for_review";
  requestId: string;
  planKey: string;
  packageKey: string;
  marketingDiscoveryPlanKey?: string;
  campaignContextKey?: string;
  creativeBriefKey?: string;
  reviewPackageKey?: string;
  holdReason?:
    | "production_skill_adapters_pending"
    | "marketing_discovery_runtime_disabled"
    | "marketing_discovery_secret_missing"
    | "authenticated_crawl_credential_resolver_pending"
    | "marketing_video_provider_pending";
}

interface MarketingRuntimeSecretEnv extends Env {
  FIRECRAWL_API_KEY?: string;
}

function assertProductionPlan(value: unknown): asserts value is ProductionPlan {
  if (!value || typeof value !== "object") throw new Error("production plan payload is required");
  const candidate = value as Partial<ProductionPlan>;
  if (candidate.schemaVersion !== "tmg.production-plan.v1") throw new Error("unsupported production plan version");
  if (!candidate.requestId || !candidate.tenantId || !candidate.title) throw new Error("production plan identity is incomplete");
  if (!Array.isArray(candidate.sourceInputs) || candidate.sourceInputs.length === 0) throw new Error("production plan source inputs are required");
  if (!Array.isArray(candidate.distributionTargets) || candidate.distributionTargets.length === 0) {
    throw new Error("production plan distribution targets are required");
  }
  if (!Array.isArray(candidate.deliverables) || candidate.deliverables.length === 0) throw new Error("production plan deliverables are required");
  if (candidate.governance?.publicationAuthority !== false) throw new Error("production workflow cannot receive publication authority");
  if (candidate.governance?.externalDistributionAuthority !== false) throw new Error("production workflow cannot receive external distribution authority");
  if (candidate.governance?.rightsEvidenceRequired !== true) throw new Error("production plan must require rights evidence");
  if (candidate.governance?.discoveredAssetReuseRequiresRightsEvidence !== true) {
    throw new Error("production plan must require rights evidence for discovered asset reuse");
  }
}

async function putImmutableJson(bucket: R2Bucket, key: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value);
  const existing = await bucket.get(key);
  if (existing) {
    const current = await existing.text();
    if (current !== serialized) throw new Error(`immutable production artifact conflict: ${key}`);
    return;
  }
  await bucket.put(key, serialized, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { immutable: "true", schema: "tmg-production-v1" },
  });
}

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`required marketing artifact is missing: ${key}`);
  return object.json<T>();
}

function requireProductionRequests(env: Env): NonNullable<Env["PRODUCTION_REQUESTS"]> {
  if (!env.PRODUCTION_REQUESTS) {
    throw new Error("production request coordinator binding is not configured in this environment");
  }
  return env.PRODUCTION_REQUESTS;
}

function campaignContextKey(tenantId: string, requestId: string): string {
  return `tenants/${tenantId}/production-requests/${requestId}/marketing/campaign-context-v1.json`;
}

function creativeBriefKey(tenantId: string, requestId: string): string {
  return `tenants/${tenantId}/production-requests/${requestId}/marketing/creative-brief-v1.json`;
}

function socialCopyKey(tenantId: string, requestId: string): string {
  return `tenants/${tenantId}/production-requests/${requestId}/marketing/social-copy-v1.json`;
}

function reviewPackageKey(tenantId: string, requestId: string): string {
  return `tenants/${tenantId}/production-requests/${requestId}/outputs/marketing/review-package-v1.json`;
}

function crawlSnapshotKey(
  tenantId: string,
  requestId: string,
  sourceIndex: number,
  jobId: string,
): string {
  const safeJobId = jobId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 160);
  return `tenants/${tenantId}/production-requests/${requestId}/marketing/discovery/source-${sourceIndex + 1}-${safeJobId}.json`;
}

async function hold(
  env: Env,
  event: WorkflowEvent<ProductionPlan>,
  reason: NonNullable<ProductionWorkflowResult["holdReason"]>,
): Promise<void> {
  const coordinator = requireProductionRequests(env).getByName(event.payload.requestId);
  await coordinator.recordWorkflowHold(event.instanceId, reason, event.timestamp.toISOString());
}

function marketingVideoRuntimeReady(env: Env): boolean {
  const acceptance = String(env.TMG_MARKETING_VIDEO_PROVIDER_ACCEPTANCE_STATE ?? "unverified");
  return (
    String(env.TMG_MARKETING_VIDEO_GENERATION_ENABLED) === "true" &&
    String(env.TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED) === "true" &&
    env.TMG_MARKETING_VIDEO_PROVIDER_ID === "pruna/p-video" &&
    (acceptance === "development_canary" || acceptance === "verified") &&
    Boolean(env.AI)
  );
}

function compactWorkflowFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000) || "unknown_workflow_failure";
}

function payloadRequestId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const requestId = (value as { requestId?: unknown }).requestId;
  return typeof requestId === "string" && requestId.trim() ? requestId.trim() : undefined;
}

export class ProductionWorkflow extends WorkflowEntrypoint<Env, ProductionPlan> {
  async run(
    event: WorkflowEvent<ProductionPlan>,
    step: WorkflowStep,
  ): Promise<ProductionWorkflowResult> {
    try {
      return await this.execute(event, step);
    } catch (error) {
      const requestId = payloadRequestId(event.payload);
      const reason = compactWorkflowFailure(error);
      console.error(JSON.stringify({
        level: "error",
        event: "production_workflow_failed",
        workflowInstanceId: event.instanceId,
        requestId: requestId ?? null,
        reason,
      }));
      if (requestId) {
        try {
          await step.do(
            "record terminal production workflow failure",
            { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" }, timeout: "1 minute" },
            async () => {
              const coordinator = requireProductionRequests(this.env).getByName(requestId);
              await coordinator.markFailed(event.instanceId, reason, new Date().toISOString());
            },
          );
        } catch (failureRecordError) {
          console.error(JSON.stringify({
            level: "error",
            event: "production_workflow_failure_record_failed",
            workflowInstanceId: event.instanceId,
            requestId,
            reason: compactWorkflowFailure(failureRecordError),
          }));
        }
      }
      throw error;
    }
  }

  private async execute(
    event: WorkflowEvent<ProductionPlan>,
    step: WorkflowStep,
  ): Promise<ProductionWorkflowResult> {
    const plan = await step.do("validate immutable production plan", async () => {
      assertProductionPlan(event.payload);
      return event.payload;
    });
    const planKey = productionPlanObjectKey(plan.tenantId, plan.requestId);
    const packageKey = productionPackageObjectKey(plan.tenantId, plan.requestId);

    await step.do("persist immutable production plan", async () => {
      await putImmutableJson(this.env.MEDIA_BUCKET, planKey, plan);
    });

    await step.do("bind processing state", async () => {
      const coordinator = requireProductionRequests(this.env).getByName(plan.requestId);
      await coordinator.markProcessing(event.instanceId, event.timestamp.toISOString());
    });

    const marketingDiscoveryPlan = await step.do(
      "compile governed marketing discovery plan",
      async () => buildMarketingDiscoveryPlan(plan),
    );
    const marketingDiscoveryPlanKey = marketingDiscoveryPlan
      ? marketingDiscoveryPlanObjectKey(plan.tenantId, plan.requestId)
      : undefined;

    if (marketingDiscoveryPlan && marketingDiscoveryPlanKey) {
      await step.do("persist governed marketing discovery plan", async () => {
        await putImmutableJson(
          this.env.MEDIA_BUCKET,
          marketingDiscoveryPlanKey,
          marketingDiscoveryPlan,
        );
      });
    }

    const productionPackage: ProductionPackageManifest = await step.do(
      "compile production package manifest",
      async () => ({
        schemaVersion: "tmg.production-package.v1",
        requestId: plan.requestId,
        tenantId: plan.tenantId,
        status: "planned",
        productionPlanKey: planKey,
        ...(marketingDiscoveryPlanKey ? { marketingDiscoveryPlanKey } : {}),
        distributionTargets: plan.distributionTargets,
        deliverables: plan.deliverables.map((deliverable) => ({
          type: deliverable.type,
          skill: deliverable.skill,
          targets: deliverable.targets,
          status: "pending_skill_activation" as const,
          artifacts: [] as [],
        })),
        publicationAuthority: false,
        externalDistributionAuthority: false,
        createdAt: event.timestamp.toISOString(),
      }),
    );

    await step.do("persist production package manifest", async () => {
      await putImmutableJson(this.env.MEDIA_BUCKET, packageKey, productionPackage);
    });

    if (!marketingDiscoveryPlan || !marketingDiscoveryPlanKey) {
      await step.do("hold non-marketing request for production skills", async () => {
        await hold(this.env, event, "production_skill_adapters_pending");
      });
      return {
        status: "planned",
        requestId: plan.requestId,
        planKey,
        packageKey,
        holdReason: "production_skill_adapters_pending",
      };
    }

    const runtimeEnv = this.env as MarketingRuntimeSecretEnv;
    if (String(runtimeEnv.TMG_MARKETING_DISCOVERY_ENABLED) !== "true") {
      await step.do("hold disabled marketing discovery runtime", async () => {
        await hold(this.env, event, "marketing_discovery_runtime_disabled");
      });
      return {
        status: "planned",
        requestId: plan.requestId,
        planKey,
        packageKey,
        marketingDiscoveryPlanKey,
        holdReason: "marketing_discovery_runtime_disabled",
      };
    }
    if (!runtimeEnv.FIRECRAWL_API_KEY?.trim()) {
      await step.do("hold missing marketing discovery secret", async () => {
        await hold(this.env, event, "marketing_discovery_secret_missing");
      });
      return {
        status: "planned",
        requestId: plan.requestId,
        planKey,
        packageKey,
        marketingDiscoveryPlanKey,
        holdReason: "marketing_discovery_secret_missing",
      };
    }
    if (marketingDiscoveryPlan.sources.some((source) => source.authorization.authenticatedCrawlAuthorized)) {
      await step.do("hold authenticated crawl until credential resolver exists", async () => {
        await hold(this.env, event, "authenticated_crawl_credential_resolver_pending");
      });
      return {
        status: "planned",
        requestId: plan.requestId,
        planKey,
        packageKey,
        marketingDiscoveryPlanKey,
        holdReason: "authenticated_crawl_credential_resolver_pending",
      };
    }

    const crawlKeys: string[] = [];
    for (let sourceIndex = 0; sourceIndex < marketingDiscoveryPlan.sources.length; sourceIndex += 1) {
      const source = marketingDiscoveryPlan.sources[sourceIndex];
      if (!source) throw new Error("marketing discovery source is missing");
      const started = await step.do(
        `start dynamic marketing discovery ${sourceIndex + 1}`,
        { retries: { limit: 1, delay: "2 seconds", backoff: "constant" }, timeout: "3 minutes" },
        async () => startMarketingCrawl(runtimeEnv, source),
      );

      let completedKey: string | undefined;
      for (let poll = 0; poll < 90; poll += 1) {
        const snapshotState = await step.do(
          `poll marketing crawl ${sourceIndex + 1} attempt ${poll + 1}`,
          { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "2 minutes" },
          async () => {
            const snapshot = await getMarketingCrawlSnapshot(runtimeEnv, started.jobId);
            if (snapshot.status === "failed") {
              throw new Error(`Firecrawl marketing crawl failed: ${started.jobId}`);
            }
            if (snapshot.status === "completed") {
              const key = crawlSnapshotKey(
                plan.tenantId,
                plan.requestId,
                sourceIndex,
                started.jobId,
              );
              await putImmutableJson(this.env.MEDIA_BUCKET, key, {
                ...snapshot,
                executionDiscovery: started.discovery,
              });
              return {
                status: snapshot.status,
                key,
                total: snapshot.total,
                completed: snapshot.completed,
              };
            }
            return {
              status: snapshot.status,
              total: snapshot.total,
              completed: snapshot.completed,
            };
          },
        );
        if (snapshotState.status === "completed" && snapshotState.key) {
          completedKey = snapshotState.key;
          break;
        }
        await step.sleep(`wait for marketing crawl ${sourceIndex + 1} attempt ${poll + 1}`, "5 seconds");
      }
      if (!completedKey) throw new Error(`Firecrawl marketing crawl timed out: ${started.jobId}`);
      crawlKeys.push(completedKey);
    }

    const contextKey = campaignContextKey(plan.tenantId, plan.requestId);
    const context = await step.do("compile canonical campaign context", async () => {
      const crawls: FirecrawlMarketingCrawlSnapshot[] = [];
      for (const key of crawlKeys) {
        crawls.push(await readJson<FirecrawlMarketingCrawlSnapshot>(this.env.MEDIA_BUCKET, key));
      }
      const manifest = compileCampaignContextManifest({
        discoveryPlan: marketingDiscoveryPlan,
        crawls,
        compiledAt: event.timestamp.toISOString(),
      });
      await putImmutableJson(this.env.MEDIA_BUCKET, contextKey, manifest);
      return manifest;
    });

    const briefKey = creativeBriefKey(plan.tenantId, plan.requestId);
    const creativeBrief = await step.do("compile adaptive target-aware marketing creative brief", async () => {
      const brief = compileMarketingCreativeBrief({
        plan,
        context: context as CampaignContextManifest,
        compiledAt: event.timestamp.toISOString(),
      });
      await putImmutableJson(this.env.MEDIA_BUCKET, briefKey, brief);
      return brief;
    });

    let copyKey: string | undefined;
    if (plan.deliverables.some((deliverable) => deliverable.type === "social_copy")) {
      copyKey = socialCopyKey(plan.tenantId, plan.requestId);
      await step.do("compile grounded social copy", async () => {
        const socialCopy = compileMarketingSocialCopy(creativeBrief as MarketingCreativeBrief);
        await putImmutableJson(this.env.MEDIA_BUCKET, copyKey as string, socialCopy);
      });
    }

    const wantsMarketingVideos = plan.deliverables.some(
      (deliverable) => deliverable.type === "branded_marketing_videos",
    );
    if (wantsMarketingVideos && !creativeBrief.contextQuality.generationEligible) {
      throw new Error(
        `marketing_context_quality_insufficient:${creativeBrief.contextQuality.score}:${creativeBrief.contextQuality.warnings.join(",")}`,
      );
    }
    if (wantsMarketingVideos && !marketingVideoRuntimeReady(this.env)) {
      await step.do("hold marketing video generation pending provider authority", async () => {
        await hold(this.env, event, "marketing_video_provider_pending");
      });
      return {
        status: "planned",
        requestId: plan.requestId,
        planKey,
        packageKey,
        marketingDiscoveryPlanKey,
        campaignContextKey: contextKey,
        creativeBriefKey: briefKey,
        holdReason: "marketing_video_provider_pending",
      };
    }

    const videos: MarketingVideoArtifact[] = [];
    if (wantsMarketingVideos) {
      for (
        let batchStart = 0;
        batchStart < creativeBrief.variants.length;
        batchStart += MAX_PARALLEL_MARKETING_VIDEO_GENERATIONS
      ) {
        const batch = creativeBrief.variants.slice(
          batchStart,
          batchStart + MAX_PARALLEL_MARKETING_VIDEO_GENERATIONS,
        );
        const generated = await Promise.all(
          batch.map((variant, batchOffset) => {
            const index = batchStart + batchOffset;
            return step.do(
              `generate marketing preview ${index + 1} ${variant.targetProfile.profileId}`,
              { retries: { limit: 1, delay: "15 seconds", backoff: "exponential" }, timeout: "10 minutes" },
              async () => generateMarketingVideoVariant(this.env, {
                requestId: plan.requestId,
                tenantId: plan.tenantId,
                variant,
                createdAt: event.timestamp.toISOString(),
              }),
            );
          }),
        );
        videos.push(...generated);
      }
    }

    const finalReviewKey = reviewPackageKey(plan.tenantId, plan.requestId);
    const reviewPackage: MarketingReviewPackage = {
      schemaVersion: "tmg.marketing-review-package.v1",
      requestId: plan.requestId,
      tenantId: plan.tenantId,
      campaignContextKey: contextKey,
      creativeBriefKey: briefKey,
      ...(copyKey ? { socialCopyKey: copyKey } : {}),
      videos,
      humanReviewRequired: true,
      publicationAuthority: false,
      externalDistributionAuthority: false,
      createdAt: event.timestamp.toISOString(),
    };
    await step.do("persist marketing review package", async () => {
      await putImmutableJson(this.env.MEDIA_BUCKET, finalReviewKey, reviewPackage);
    });
    await step.do("complete production into human review", async () => {
      const coordinator = requireProductionRequests(this.env).getByName(plan.requestId);
      await coordinator.markCompleted(event.instanceId, event.timestamp.toISOString());
    });

    return {
      status: "ready_for_review",
      requestId: plan.requestId,
      planKey,
      packageKey,
      marketingDiscoveryPlanKey,
      campaignContextKey: contextKey,
      creativeBriefKey: briefKey,
      reviewPackageKey: finalReviewKey,
    };
  }
}
