import type { ReviewEnv, WorkRequestManifest } from "./work-review-core";
import { chainOf, validateReceiptSha, type DerivativeReceipt, type RightsSufficiencyVerdict } from "./processor-chain-core";

export type PublicationAuthorityEnvelope = {
  schema: "tmg.publication-authority.v1";
  authorityId: string;
  requestId: string;
  reviewId: string;
  derivativeReceiptSha256: string;
  rightsVerdictSha256: string;
  outputKeys: string[];
  grantedBy: string;
  grantedAt: string;
  expiresAt: string;
};

export type ProviderEgressAuthorityEnvelope = {
  schema: "tmg.provider-egress-authority.v1";
  authorityId: string;
  requestId: string;
  reviewId: string;
  providerId: string;
  endpoint: string;
  purpose: string;
  payloadSha256: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt: string;
};

function allowedProviderEndpoints(env: ReviewEnv): Set<string> {
  return new Set(String(env.TMG_PROVIDER_ENDPOINT_ALLOWLIST ?? "").split(/[,;\s]+/).map((value) => value.trim()).filter(Boolean));
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function publishAuthorizedDerivatives(
  env: ReviewEnv,
  manifest: WorkRequestManifest,
  authority: PublicationAuthorityEnvelope,
): Promise<{ published: Array<{ sourceKey: string; publishedKey: string; sha256: string; size: number }> }> {
  if (env.TMG_PUBLICATION_EXECUTION_ENABLED !== "true") throw new Error("publication_execution_globally_disabled");
  if (manifest.controls.publicationAuthorized !== true) throw new Error("publication_authority_not_active");
  if (!manifest.review?.reviewId || authority.reviewId !== manifest.review.reviewId || authority.requestId !== manifest.requestId) throw new Error("publication_authority_binding_mismatch");
  if (Date.parse(authority.expiresAt) <= Date.now()) throw new Error("publication_authority_expired");
  const chain = chainOf(manifest);
  const derivative = chain?.derivativeReceipt;
  const rights = chain?.rightsVerdict;
  if (!derivative || !rights) throw new Error("publication_upstream_receipts_missing");
  if (!(await validateReceiptSha(derivative as unknown as Record<string, unknown>)) || !(await validateReceiptSha(rights as unknown as Record<string, unknown>))) throw new Error("publication_upstream_receipt_hash_invalid");
  if (rights.state !== "sufficient" || !rights.permittedUses.includes("publication")) throw new Error("publication_not_permitted_by_rights_verdict");
  if (authority.derivativeReceiptSha256 !== derivative.receiptSha256 || authority.rightsVerdictSha256 !== rights.receiptSha256) throw new Error("publication_upstream_receipt_mismatch");
  const derivativeKeys = new Set(derivative.outputs.map((output) => output.key));
  if (authority.outputKeys.length === 0 || authority.outputKeys.some((key) => !derivativeKeys.has(key))) throw new Error("publication_output_scope_invalid");

  const published = [];
  for (const key of authority.outputKeys) {
    const source = await env.DERIVATIVES.get(key);
    if (!source) throw new Error(`publication_source_missing:${key}`);
    const bytes = new Uint8Array(await source.arrayBuffer());
    const sha256 = await sha256Bytes(bytes);
    const expected = source.customMetadata?.sha256;
    if (!expected || sha256.toLowerCase() !== expected.toLowerCase()) throw new Error(`publication_source_sha_mismatch:${key}`);
    const publishedKey = `published/${manifest.requestId}/${derivative.receiptId}/${key.split("/").pop() ?? "asset"}`;
    await env.PUBLISHED_MEDIA.put(publishedKey, bytes, {
      sha256,
      httpMetadata: {
        contentType: source.httpMetadata?.contentType ?? "application/octet-stream",
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: {
        sha256,
        requestId: manifest.requestId,
        derivativeReceiptSha256: derivative.receiptSha256,
        rightsVerdictSha256: rights.receiptSha256,
        publicationAuthorityId: authority.authorityId,
      },
    });
    published.push({ sourceKey: key, publishedKey, sha256, size: bytes.byteLength });
  }
  return { published };
}

export async function callAuthorizedExternalProvider(
  env: ReviewEnv,
  manifest: WorkRequestManifest,
  authority: ProviderEgressAuthorityEnvelope,
  payload: Uint8Array,
  contentType = "application/json",
): Promise<Response> {
  if (env.TMG_EXTERNAL_PROVIDER_EGRESS_ENABLED !== "true") throw new Error("external_provider_egress_globally_disabled");
  if (manifest.controls.externalProviderEgressAuthorized !== true) throw new Error("external_provider_egress_authority_not_active");
  if (!manifest.review?.reviewId || authority.reviewId !== manifest.review.reviewId || authority.requestId !== manifest.requestId) throw new Error("provider_egress_authority_binding_mismatch");
  if (Date.parse(authority.expiresAt) <= Date.now()) throw new Error("provider_egress_authority_expired");
  if (!allowedProviderEndpoints(env).has(authority.endpoint)) throw new Error("provider_endpoint_not_allowlisted");
  const payloadSha256 = await sha256Bytes(payload);
  if (payloadSha256 !== authority.payloadSha256) throw new Error("provider_payload_sha_mismatch");
  const chain = chainOf(manifest);
  const rights = chain?.rightsVerdict as RightsSufficiencyVerdict | undefined;
  if (!rights || rights.state !== "sufficient" || !rights.permittedUses.includes("external_provider")) throw new Error("external_provider_not_permitted_by_rights_verdict");
  if (!(await validateReceiptSha(rights as unknown as Record<string, unknown>))) throw new Error("rights_verdict_hash_invalid");

  const headers = new Headers({
    "content-type": contentType,
    "x-tmg-request-id": manifest.requestId,
    "x-tmg-authority-id": authority.authorityId,
  });
  if (env.TMG_PROVIDER_AUTHORIZATION) headers.set("authorization", env.TMG_PROVIDER_AUTHORIZATION);
  return fetch(authority.endpoint, { method: "POST", headers, body: payload });
}

export function derivativeReceiptForPublication(manifest: WorkRequestManifest): DerivativeReceipt | null {
  return chainOf(manifest)?.derivativeReceipt ?? null;
}
