export type TmgUiBootstrap = {
  schema: "tmg.ui-bootstrap.v1";
  service: "tmg-video-services";
  publicStatusGate: "G0";
  classification: "shared_commercial_infrastructure_prototype";
  valueProposition: string;
  runtime: {
    publicApiEnabled: boolean;
    mcpEnabled: boolean;
    ingestWorkflowEnabled: boolean;
    externalProviderEgressEnabled: boolean;
    providerAcceptanceState: string;
    tenantUsageLedgerEnabled: boolean;
    policyVersion: string;
    embedding: {
      providerId: string;
      dimensions: number;
    };
  };
  release: {
    status: "s0_s1_implemented_unactivated";
    activationAuthorized: false;
    publicTrafficAuthorized: false;
    publicApiAuthorized: false;
    mcpAuthorized: false;
    ingestionAuthorized: false;
    externalProviderEgressAuthorized: false;
    providerPromotionAuthorized: false;
    billingAuthorized: false;
    commercialUseAuthorized: false;
    maxExecutableStage: "S1";
    stages: Array<{
      id: "S0" | "S1" | "S2" | "S3" | "S4" | "S5";
      state: "implemented_unactivated" | "not_implemented";
      humanApprovalRequired: boolean;
      normalTrafficPercentageMax: number;
    }>;
  };
  requestIntake: {
    localDraftEnabled: true;
    manifestExportEnabled: true;
    authenticatedIntakeEnabled: boolean;
    controlDbBindingState: string;
    authentication: "cloudflare-access";
    consoleHost: string;
    rightsFirst: true;
    independentRightsReviewRequired: true;
    backendSubmissionEnabled: boolean;
    fileTransferEnabled: boolean;
    submissionAuthority: false;
    processingAuthority: false;
    publicationAuthority: false;
    commercialAuthority: false;
  };
  authorityBoundary: {
    semanticSimilarityGrantsAuthority: false;
    successfulDeploymentGrantsAuthority: false;
    acceptanceEvidenceGrantsAuthority: false;
    infrastructureExistenceGrantsAuthority: false;
    humanReleaseApprovalRequired: true;
  };
};

function enabled(value: string | undefined): boolean {
  return value === "true";
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function buildUiBootstrap(env: Env): TmgUiBootstrap {
  const intakeEnabled = enabled(env.TMG_INTAKE_ENABLED) && env.TMG_CONTROL_DB_BINDING_STATE === "provisioned";
  return {
    schema: "tmg.ui-bootstrap.v1",
    service: "tmg-video-services",
    publicStatusGate: "G0",
    classification: "shared_commercial_infrastructure_prototype",
    valueProposition:
      "Convert authorized video into governed, temporally searchable intelligence without expanding the rights attached to the source media.",
    runtime: {
      publicApiEnabled: enabled(env.TMG_PUBLIC_API_ENABLED),
      mcpEnabled: enabled(env.TMG_MCP_ENABLED),
      ingestWorkflowEnabled: enabled(env.TMG_INGEST_WORKFLOW_ENABLED),
      externalProviderEgressEnabled: enabled(env.TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED),
      providerAcceptanceState: env.TMG_PROVIDER_ACCEPTANCE_STATE || "unverified",
      tenantUsageLedgerEnabled: enabled(env.TMG_TENANT_USAGE_LEDGER_ENABLED),
      policyVersion: env.TMG_POLICY_VERSION || "unknown",
      embedding: {
        providerId: env.TMG_EMBEDDING_PROVIDER_ID || "unknown",
        dimensions: positiveInteger(env.TMG_EMBEDDING_DIMENSIONS, 512),
      },
    },
    release: {
      status: "s0_s1_implemented_unactivated",
      activationAuthorized: false,
      publicTrafficAuthorized: false,
      publicApiAuthorized: false,
      mcpAuthorized: false,
      ingestionAuthorized: false,
      externalProviderEgressAuthorized: false,
      providerPromotionAuthorized: false,
      billingAuthorized: false,
      commercialUseAuthorized: false,
      maxExecutableStage: "S1",
      stages: [
        { id: "S0", state: "implemented_unactivated", humanApprovalRequired: false, normalTrafficPercentageMax: 0 },
        { id: "S1", state: "implemented_unactivated", humanApprovalRequired: true, normalTrafficPercentageMax: 0 },
        { id: "S2", state: "not_implemented", humanApprovalRequired: true, normalTrafficPercentageMax: 1 },
        { id: "S3", state: "not_implemented", humanApprovalRequired: true, normalTrafficPercentageMax: 5 },
        { id: "S4", state: "not_implemented", humanApprovalRequired: true, normalTrafficPercentageMax: 25 },
        { id: "S5", state: "not_implemented", humanApprovalRequired: true, normalTrafficPercentageMax: 100 },
      ],
    },
    requestIntake: {
      localDraftEnabled: true,
      manifestExportEnabled: true,
      authenticatedIntakeEnabled: intakeEnabled,
      controlDbBindingState: env.TMG_CONTROL_DB_BINDING_STATE || "unprovisioned",
      authentication: "cloudflare-access",
      consoleHost: env.TMG_CONSOLE_HOST || "console.tolanimediagroup.com",
      rightsFirst: true,
      independentRightsReviewRequired: true,
      backendSubmissionEnabled: intakeEnabled,
      fileTransferEnabled: intakeEnabled,
      submissionAuthority: false,
      processingAuthority: false,
      publicationAuthority: false,
      commercialAuthority: false,
    },
    authorityBoundary: {
      semanticSimilarityGrantsAuthority: false,
      successfulDeploymentGrantsAuthority: false,
      acceptanceEvidenceGrantsAuthority: false,
      infrastructureExistenceGrantsAuthority: false,
      humanReleaseApprovalRequired: true,
    },
  };
}
