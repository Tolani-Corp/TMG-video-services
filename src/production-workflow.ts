import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { buildMarketingDiscoveryPlan } from "./marketing-context";
import {
  marketingDiscoveryPlanObjectKey,
  productionPackageObjectKey,
  productionPlanObjectKey,
  type ProductionPlan,
} from "./production-request";

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
  status: "planned";
  requestId: string;
  planKey: string;
  packageKey: string;
  marketingDiscoveryPlanKey?: string;
  holdReason:
    | "production_skill_adapters_pending"
    | "marketing_discovery_adapter_pending";
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

function requireProductionRequests(env: Env): NonNullable<Env["PRODUCTION_REQUESTS"]> {
  if (!env.PRODUCTION_REQUESTS) {
    throw new Error("production request coordinator binding is not configured in this environment");
  }
  return env.PRODUCTION_REQUESTS;
}

export class ProductionWorkflow extends WorkflowEntrypoint<Env, ProductionPlan> {
  async run(
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

    const holdReason = marketingDiscoveryPlan
      ? "marketing_discovery_adapter_pending" as const
      : "production_skill_adapters_pending" as const;

    await step.do("hold until governed adapters are active", async () => {
      const coordinator = requireProductionRequests(this.env).getByName(plan.requestId);
      await coordinator.recordWorkflowHold(
        event.instanceId,
        holdReason,
        new Date().toISOString(),
      );
    });

    return {
      status: "planned",
      requestId: plan.requestId,
      planKey,
      packageKey,
      ...(marketingDiscoveryPlanKey ? { marketingDiscoveryPlanKey } : {}),
      holdReason,
    };
  }
}
