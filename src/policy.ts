import type {
  RetrievalContext,
  RetrievalDecision,
  RetrievalPurpose,
  RightsEnvelope,
  VideoSegmentRecord,
} from "./domain";

const PURPOSE_TO_GRANT = {
  external_api: "externalApi",
  mcp: "mcp",
  advertising: "advertising",
  dataset_export: "datasetExport",
  licensing: "licensing",
} as const;

type ExplicitPurpose = keyof typeof PURPOSE_TO_GRANT;

function isExplicitPurpose(purpose: RetrievalPurpose): purpose is ExplicitPurpose {
  return purpose !== "internal_search";
}

function isExpired(rights: RightsEnvelope, nowIso: string): boolean {
  if (!rights.expiresAt) return false;
  return Date.parse(rights.expiresAt) <= Date.parse(nowIso);
}

export function evaluateRetrievalPolicy(
  segment: VideoSegmentRecord,
  context: RetrievalContext,
): RetrievalDecision {
  const reasons: string[] = [];
  const nowIso = context.nowIso ?? new Date().toISOString();

  if (segment.rights.evidenceState !== "verified") {
    reasons.push("rights_evidence_not_verified");
  }

  if (isExpired(segment.rights, nowIso)) {
    reasons.push("rights_expired");
  }

  if (segment.tenantId !== context.tenantId) {
    reasons.push("tenant_mismatch");
  }

  if (
    segment.rights.allowedTenantIds.length > 0 &&
    !segment.rights.allowedTenantIds.includes(context.tenantId)
  ) {
    reasons.push("tenant_not_granted");
  }

  if (
    context.territory &&
    segment.rights.allowedTerritories.length > 0 &&
    !segment.rights.allowedTerritories.includes(context.territory)
  ) {
    reasons.push("territory_not_granted");
  }

  if (context.purpose === "internal_search") {
    if (segment.publicationState === "blocked") {
      reasons.push("segment_blocked");
    }
  } else {
    if (segment.publicationState !== "approved") {
      reasons.push("publication_not_approved");
    }

    if (isExplicitPurpose(context.purpose)) {
      const grant = PURPOSE_TO_GRANT[context.purpose];
      if (!segment.rights.grants[grant]) {
        reasons.push(`purpose_not_granted:${context.purpose}`);
      }
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}

export function purposeFilterKey(
  purpose: RetrievalPurpose,
): "externalApi" | "mcp" | "advertising" | "datasetExport" | "licensing" | null {
  if (!isExplicitPurpose(purpose)) return null;
  return PURPOSE_TO_GRANT[purpose];
}
