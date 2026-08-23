import type {
  EntitlementDecision,
  EntitlementRequest,
  TenantEntitlement,
  TenantEntitlementRegistry,
  UsageSnapshot,
} from "./entitlements";
import { evaluateTenantEntitlement, getTenantEntitlement } from "./entitlements";

export interface TenantIdentityPrincipal {
  tenantId: string;
  enabled: boolean;
}

export interface TenantIdentityIssuer {
  audiences: readonly string[];
  environment: "development" | "preview" | "production";
  principals: Readonly<Record<string, TenantIdentityPrincipal>>;
}

export interface TenantIdentityRegistry {
  schemaVersion: string;
  defaultDecision: "deny";
  issuers: Readonly<Record<string, TenantIdentityIssuer>>;
}

export interface TenantCredentialClaims {
  iss: string;
  aud: string | string[];
  sub: string;
  jti: string;
  iat: number;
  nbf?: number;
  exp: number;
  env: "development" | "preview" | "production";
}

export interface AuthenticatedTenantPrincipal {
  issuer: string;
  subject: string;
  tenantId: string;
  credentialId: string;
  environment: "development" | "preview" | "production";
  issuedAt: number;
  expiresAt: number;
}

export interface TenantCredentialVerificationOptions {
  registry: TenantIdentityRegistry;
  verificationKeys: Readonly<Record<string, JsonWebKey>>;
  expectedAudience: string;
  expectedEnvironment: "development" | "preview" | "production";
  nowMs?: number;
  clockSkewSeconds?: number;
}

export interface AuthenticatedEntitlementDecision extends EntitlementDecision {
  entitlement?: TenantEntitlement;
}

export class TenantAuthenticationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "TenantAuthenticationError";
    this.code = code;
  }
}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TenantAuthenticationError("credential_malformed");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  try {
    const binary = atob(`${normalized}${padding}`);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    throw new TenantAuthenticationError("credential_malformed");
  }
}

function decodeJsonSegment(value: string): unknown {
  try {
    return JSON.parse(textDecoder.decode(decodeBase64Url(value)));
  } catch (error) {
    if (error instanceof TenantAuthenticationError) throw error;
    throw new TenantAuthenticationError("credential_malformed");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new TenantAuthenticationError(`credential_${field}_invalid`);
  }
  return value;
}

function requireEpoch(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TenantAuthenticationError(`credential_${field}_invalid`);
  }
  return Number(value);
}

function parseAudience(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) return [value];
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0)) {
    return [...new Set(value)];
  }
  throw new TenantAuthenticationError("credential_aud_invalid");
}

export async function verifyTenantCredential(
  credential: string,
  options: TenantCredentialVerificationOptions,
): Promise<AuthenticatedTenantPrincipal> {
  if (typeof credential !== "string" || credential.length === 0 || credential.length > 16_384) {
    throw new TenantAuthenticationError("credential_malformed");
  }

  const segments = credential.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    throw new TenantAuthenticationError("credential_malformed");
  }
  const encodedHeader = segments[0]!;
  const encodedPayload = segments[1]!;
  const encodedSignature = segments[2]!;
  const header = decodeJsonSegment(encodedHeader);
  const payload = decodeJsonSegment(encodedPayload);
  if (!isRecord(header) || !isRecord(payload)) throw new TenantAuthenticationError("credential_malformed");

  if (header.alg !== "EdDSA") throw new TenantAuthenticationError("credential_algorithm_rejected");
  if (header.typ !== "JWT") throw new TenantAuthenticationError("credential_type_rejected");
  const kid = requireString(header, "kid");
  const jwk = options.verificationKeys[kid];
  if (!jwk) throw new TenantAuthenticationError("credential_key_unknown");

  let verificationKey: CryptoKey;
  try {
    verificationKey = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    throw new TenantAuthenticationError("credential_key_invalid");
  }
  const signatureValid = await crypto.subtle.verify(
    { name: "Ed25519" },
    verificationKey,
    decodeBase64Url(encodedSignature),
    textEncoder.encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!signatureValid) throw new TenantAuthenticationError("credential_signature_invalid");

  const issuerName = requireString(payload, "iss");
  const subject = requireString(payload, "sub");
  const credentialId = requireString(payload, "jti");
  if (credentialId.length > 256) throw new TenantAuthenticationError("credential_jti_invalid");
  const audiences = parseAudience(payload.aud);
  const issuedAt = requireEpoch(payload, "iat");
  const expiresAt = requireEpoch(payload, "exp");
  const notBefore = payload.nbf === undefined ? issuedAt : requireEpoch(payload, "nbf");
  const environment = requireString(payload, "env");
  if (!["development", "preview", "production"].includes(environment)) {
    throw new TenantAuthenticationError("credential_env_invalid");
  }

  const issuer = options.registry.issuers[issuerName];
  if (!issuer) throw new TenantAuthenticationError("credential_issuer_rejected");
  if (issuer.environment !== options.expectedEnvironment || environment !== options.expectedEnvironment) {
    throw new TenantAuthenticationError("credential_environment_rejected");
  }
  if (!issuer.audiences.includes(options.expectedAudience) || !audiences.includes(options.expectedAudience)) {
    throw new TenantAuthenticationError("credential_audience_rejected");
  }

  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const skew = options.clockSkewSeconds ?? 30;
  if (!Number.isSafeInteger(skew) || skew < 0 || skew > 300) {
    throw new TenantAuthenticationError("credential_clock_skew_invalid");
  }
  if (issuedAt > nowSeconds + skew || notBefore > nowSeconds + skew) {
    throw new TenantAuthenticationError("credential_not_yet_valid");
  }
  if (expiresAt <= nowSeconds - skew || expiresAt <= issuedAt) {
    throw new TenantAuthenticationError("credential_expired");
  }
  if (expiresAt - issuedAt > 900) throw new TenantAuthenticationError("credential_ttl_exceeded");

  const identity = issuer.principals[subject];
  if (!identity) throw new TenantAuthenticationError("principal_not_registered");
  if (!identity.enabled) throw new TenantAuthenticationError("principal_disabled");
  if (!identity.tenantId || identity.tenantId.length > 128) {
    throw new TenantAuthenticationError("principal_tenant_invalid");
  }

  return {
    issuer: issuerName,
    subject,
    tenantId: identity.tenantId,
    credentialId,
    environment: options.expectedEnvironment,
    issuedAt,
    expiresAt,
  };
}

export function evaluateAuthenticatedTenantEntitlement(
  principal: AuthenticatedTenantPrincipal,
  registry: TenantEntitlementRegistry,
  request: Omit<EntitlementRequest, "tenantId">,
  usage: UsageSnapshot,
): AuthenticatedEntitlementDecision {
  const entitlement = getTenantEntitlement(registry, principal.tenantId);
  if (!entitlement) return { allowed: false, reasons: ["tenant_not_entitled"] };
  if (entitlement.environment !== principal.environment) {
    return { allowed: false, reasons: ["tenant_environment_mismatch"], entitlement };
  }
  const decision = evaluateTenantEntitlement(
    entitlement,
    { ...request, tenantId: principal.tenantId },
    usage,
  );
  return { ...decision, entitlement };
}
