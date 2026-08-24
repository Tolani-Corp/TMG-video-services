import { describe, expect, it } from "vitest";
import { buildUiBootstrap } from "../src/ui-bootstrap";

function env(overrides: Record<string, string> = {}): Env {
  return {
    TMG_PUBLIC_API_ENABLED: "false",
    TMG_MCP_ENABLED: "false",
    TMG_INGEST_WORKFLOW_ENABLED: "false",
    TMG_INGESTION_MODE: "fixture_only",
    TMG_POLICY_VERSION: "2026-08-20.v3",
    TMG_EMBEDDING_DIMENSIONS: "512",
    TMG_EMBEDDING_PROVIDER_ID: "fixture",
    TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED: "false",
    TMG_PROVIDER_ACCEPTANCE_STATE: "unverified",
    TMG_TENANT_USAGE_LEDGER_ENABLED: "false",
    TMG_INTAKE_ENABLED: "false",
    TMG_CONTROL_DB_BINDING_STATE: "unprovisioned",
    TMG_CONSOLE_HOST: "console.tolanimediagroup.com",
    ...overrides,
  } as unknown as Env;
}

describe("TMG enterprise UI bootstrap", () => {
  it("reports the G0 control posture without granting release authority", () => {
    const bootstrap = buildUiBootstrap(env());

    expect(bootstrap.publicStatusGate).toBe("G0");
    expect(bootstrap.runtime.publicApiEnabled).toBe(false);
    expect(bootstrap.runtime.mcpEnabled).toBe(false);
    expect(bootstrap.runtime.externalProviderEgressEnabled).toBe(false);
    expect(bootstrap.release.status).toBe("s0_s1_implemented_unactivated");
    expect(bootstrap.release.activationAuthorized).toBe(false);
    expect(bootstrap.release.publicTrafficAuthorized).toBe(false);
    expect(bootstrap.release.commercialUseAuthorized).toBe(false);
    expect(bootstrap.requestIntake.authenticatedIntakeEnabled).toBe(false);
    expect(bootstrap.requestIntake.backendSubmissionEnabled).toBe(false);
    expect(bootstrap.requestIntake.fileTransferEnabled).toBe(false);
    expect(bootstrap.requestIntake.processingAuthority).toBe(false);
  });

  it("requires both the explicit intake flag and a provisioned control database", () => {
    expect(buildUiBootstrap(env({ TMG_INTAKE_ENABLED: "true" })).requestIntake.authenticatedIntakeEnabled).toBe(false);
    expect(
      buildUiBootstrap(env({ TMG_CONTROL_DB_BINDING_STATE: "provisioned" })).requestIntake.authenticatedIntakeEnabled,
    ).toBe(false);

    const bootstrap = buildUiBootstrap(env({
      TMG_INTAKE_ENABLED: "true",
      TMG_CONTROL_DB_BINDING_STATE: "provisioned",
    }));
    expect(bootstrap.requestIntake.authenticatedIntakeEnabled).toBe(true);
    expect(bootstrap.requestIntake.backendSubmissionEnabled).toBe(true);
    expect(bootstrap.requestIntake.fileTransferEnabled).toBe(true);
    expect(bootstrap.requestIntake.authentication).toBe("cloudflare-access");
    expect(bootstrap.requestIntake.rightsFirst).toBe(true);
    expect(bootstrap.requestIntake.independentRightsReviewRequired).toBe(true);
    expect(bootstrap.requestIntake.submissionAuthority).toBe(false);
    expect(bootstrap.requestIntake.processingAuthority).toBe(false);
    expect(bootstrap.requestIntake.publicationAuthority).toBe(false);
    expect(bootstrap.requestIntake.commercialAuthority).toBe(false);
  });

  it("keeps runtime configuration separate from production authority", () => {
    const bootstrap = buildUiBootstrap(
      env({
        TMG_PUBLIC_API_ENABLED: "true",
        TMG_MCP_ENABLED: "true",
        TMG_INGEST_WORKFLOW_ENABLED: "true",
        TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED: "true",
        TMG_TENANT_USAGE_LEDGER_ENABLED: "true",
        TMG_PROVIDER_ACCEPTANCE_STATE: "accepted_preview",
        TMG_INTAKE_ENABLED: "true",
        TMG_CONTROL_DB_BINDING_STATE: "provisioned",
      }),
    );

    expect(bootstrap.runtime.publicApiEnabled).toBe(true);
    expect(bootstrap.runtime.mcpEnabled).toBe(true);
    expect(bootstrap.runtime.ingestWorkflowEnabled).toBe(true);
    expect(bootstrap.runtime.externalProviderEgressEnabled).toBe(true);
    expect(bootstrap.runtime.tenantUsageLedgerEnabled).toBe(true);
    expect(bootstrap.requestIntake.authenticatedIntakeEnabled).toBe(true);

    expect(bootstrap.release.activationAuthorized).toBe(false);
    expect(bootstrap.release.externalProviderEgressAuthorized).toBe(false);
    expect(bootstrap.release.providerPromotionAuthorized).toBe(false);
    expect(bootstrap.release.billingAuthorized).toBe(false);
    expect(bootstrap.release.commercialUseAuthorized).toBe(false);
    expect(bootstrap.requestIntake.processingAuthority).toBe(false);
  });

  it("exposes only bounded, secret-free bootstrap data", () => {
    const serialized = JSON.stringify(buildUiBootstrap(env()));
    expect(serialized).not.toMatch(/api[_-]?key/i);
    expect(serialized).not.toMatch(/secret/i);
    expect(serialized).not.toMatch(/token/i);
    expect(serialized).not.toMatch(/bucket_name/i);
    expect(serialized).not.toMatch(/credential/i);
    expect(serialized).not.toMatch(/database[_-]?id/i);
  });

  it("tracks the S0/S1 implemented-unactivated release boundary", () => {
    const bootstrap = buildUiBootstrap(env());
    expect(bootstrap.release.maxExecutableStage).toBe("S1");
    expect(bootstrap.release.stages.slice(0, 2).every((stage) => stage.state === "implemented_unactivated")).toBe(true);
    expect(bootstrap.release.stages.slice(2).every((stage) => stage.state === "not_implemented")).toBe(true);
    expect(bootstrap.release.stages.find((stage) => stage.id === "S5")?.normalTrafficPercentageMax).toBe(100);
  });
});
