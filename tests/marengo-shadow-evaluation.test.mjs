import { describe, expect, it } from "vitest";
import {
  buildShadowVectorRecord,
  validateShadowControl,
} from "../scripts/marengo-shadow-evaluate.mjs";

const acceptance = {
  schemaVersion: "1.0.0",
  providers: {
    "twelvelabs-marengo3": {
      state: "development_shadow_verified",
      authority: "shadow_only",
      profileId: "twelvelabs_marengo3_fused_512_v1",
      compatibilityGroup: "marengo3_fused_512_v1",
      dimensions: 512,
      evidence: {
        workflowRunId: 32451894358,
        artifactDigest: "sha256:abc",
      },
      promotion: {
        authoritativeRoutingAllowed: false,
        publicApiAllowed: false,
        mcpAllowed: false,
        commercialUseAllowed: false,
      },
    },
  },
};

function fixture() {
  const manifest = {
    schemaVersion: "1.0.0",
    assetId: "asset_1",
    tenantId: "tenant_1",
    rightsProfileId: "rights_1",
    publicationState: "approved",
    media: {
      objectKey: "tenants/tenant_1/assets/asset_1/media/original.mp4",
      sha256: "a".repeat(64),
      bytes: 1024,
      mimeType: "video/mp4",
      durationMs: 5000,
    },
  };
  const rights = {
    schemaVersion: "1.0.0",
    assetId: "asset_1",
    tenantId: "tenant_1",
    rightsProfileId: "rights_1",
    evidenceState: "verified",
    sourceEvidenceRef: "contract://rights_1",
    allowedTenantIds: ["tenant_1"],
    allowedTerritories: [],
    grants: {
      externalApi: true,
      mcp: true,
      advertising: true,
      datasetExport: true,
      licensing: true,
    },
    revision: 3,
    updatedAt: "2026-08-21T00:00:00Z",
  };
  return { manifest, rights };
}

describe("Marengo shadow evaluation policy", () => {
  it("accepts verified canonical evidence but returns shadow-only control", () => {
    const { manifest, rights } = fixture();
    const control = validateShadowControl({
      manifest,
      rights,
      acceptance,
      nowIso: "2026-08-21T06:00:00Z",
    });
    expect(control.tenantId).toBe("tenant_1");
    expect(control.mediaObjectKey).toContain("tenants/tenant_1/assets/asset_1/");
  });

  it("fails closed for revoked or expired rights", () => {
    const { manifest, rights } = fixture();
    expect(() =>
      validateShadowControl({
        manifest,
        rights: { ...rights, evidenceState: "revoked", revokedAt: "2026-08-21T05:00:00Z" },
        acceptance,
        nowIso: "2026-08-21T06:00:00Z",
      }),
    ).toThrow(/verified, non-revoked/);

    expect(() =>
      validateShadowControl({
        manifest,
        rights: { ...rights, expiresAt: "2026-08-21T05:00:00Z" },
        acceptance,
        nowIso: "2026-08-21T06:00:00Z",
      }),
    ).toThrow(/expired/);
  });

  it("rejects cross-tenant object keys and blocked publication", () => {
    const { manifest, rights } = fixture();
    expect(() =>
      validateShadowControl({
        manifest: {
          ...manifest,
          media: { ...manifest.media, objectKey: "tenants/other/assets/asset_1/media/original.mp4" },
        },
        rights,
        acceptance,
        nowIso: "2026-08-21T06:00:00Z",
      }),
    ).toThrow(/canonical tenant\/asset prefix/);

    expect(() =>
      validateShadowControl({
        manifest: { ...manifest, publicationState: "blocked" },
        rights,
        acceptance,
        nowIso: "2026-08-21T06:00:00Z",
      }),
    ).toThrow(/Blocked assets/);
  });

  it("allows revocation control after rights become revoked", () => {
    const { manifest, rights } = fixture();
    const control = validateShadowControl({
      manifest: { ...manifest, publicationState: "blocked" },
      rights: {
        ...rights,
        evidenceState: "revoked",
        revokedAt: "2026-08-21T05:30:00Z",
        revocationReason: "rights withdrawn",
      },
      acceptance,
      nowIso: "2026-08-21T06:00:00Z",
      operation: "revoke",
    });
    expect(control.assetId).toBe("asset_1");
  });

  it("forces all shadow vectors to review-only and commercial-deny metadata", () => {
    const { manifest, rights } = fixture();
    const record = buildShadowVectorRecord({
      manifest,
      rights,
      vector: Array.from({ length: 512 }, (_, index) => index / 512),
      acceptanceEvidenceId: "32451894358:sha256:abc",
    });

    expect(record.values).toHaveLength(512);
    expect(record.metadata.publicationState).toBe("review");
    expect(record.metadata.externalApi).toBe(false);
    expect(record.metadata.mcp).toBe(false);
    expect(record.metadata.advertising).toBe(false);
    expect(record.metadata.datasetExport).toBe(false);
    expect(record.metadata.licensing).toBe(false);
    expect(record.metadata.sourcePublicationState).toBe("approved");
  });

  it("rejects acceptance records that grant authoritative routing", () => {
    const { manifest, rights } = fixture();
    const unsafe = structuredClone(acceptance);
    unsafe.providers["twelvelabs-marengo3"].promotion.authoritativeRoutingAllowed = true;
    expect(() =>
      validateShadowControl({
        manifest,
        rights,
        acceptance: unsafe,
        nowIso: "2026-08-21T06:00:00Z",
      }),
    ).toThrow(/Unsupported Marengo authority/);
  });
});
