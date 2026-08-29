const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class EnterpriseWorkloadAuthError extends Error {
  constructor(public readonly code: string, public readonly status: 401 | 403 | 500 = 401) {
    super(code);
    this.name = "EnterpriseWorkloadAuthError";
  }
}

function base64UrlBytes(segment: string): Uint8Array {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new EnterpriseWorkloadAuthError("jwt_base64_invalid");
  }
}

function jsonObject(segment: string, code: string): Record<string, unknown> {
  try {
    const value = JSON.parse(decoder.decode(base64UrlBytes(segment)));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof EnterpriseWorkloadAuthError) throw error;
    throw new EnterpriseWorkloadAuthError(code);
  }
}

function pemDer(pem: string): Uint8Array {
  if (!pem.includes("BEGIN PUBLIC KEY")) throw new EnterpriseWorkloadAuthError("verification_key_invalid", 500);
  const body = pem.replace(/-----BEGIN PUBLIC KEY-----/g, "").replace(/-----END PUBLIC KEY-----/g, "").replace(/\s+/g, "");
  try {
    const binary = atob(body);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new EnterpriseWorkloadAuthError("verification_key_invalid", 500);
  }
}

function scopes(payload: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const candidate of [payload.scope, payload.scopes, payload.scp]) {
    if (typeof candidate === "string") values.push(...candidate.split(/\s+/u));
    if (Array.isArray(candidate)) values.push(...candidate.map(String));
  }
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function audienceMatches(actual: unknown, expected: string): boolean {
  if (typeof actual === "string") return actual === expected;
  return Array.isArray(actual) && actual.map(String).includes(expected);
}

export type EnterpriseWorkloadPrincipal = Readonly<{
  kind: "workload";
  tokenType: "clerk_m2m_jwt";
  issuer: string;
  subject: string;
  audience: unknown;
  organization: "tolani";
  accessClass: "tolani-internal";
  environment: string;
  serviceId: string;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
}>;

export async function verifyEnterpriseWorkloadRequest(
  request: Request,
  options: {
    pemPublicKey: string;
    expectedIssuer: string;
    expectedAudience: string;
    expectedEnvironment: string;
    requiredScopes: string[];
    allowedServiceIds?: string[];
    maxTtlSeconds?: number;
    clockSkewSeconds?: number;
    nowEpochSeconds?: number;
  },
): Promise<EnterpriseWorkloadPrincipal> {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const bearer = /^Bearer\s+([^\s]+)$/iu.exec(authorization)?.[1];
  if (!bearer) throw new EnterpriseWorkloadAuthError("bearer_token_required");
  if (bearer.length > 16384) throw new EnterpriseWorkloadAuthError("jwt_invalid");

  const parts = bearer.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) throw new EnterpriseWorkloadAuthError("jwt_invalid");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = jsonObject(encodedHeader, "jwt_header_invalid");
  const payload = jsonObject(encodedPayload, "jwt_payload_invalid");
  if (header.alg !== "RS256") throw new EnterpriseWorkloadAuthError("jwt_algorithm_forbidden");
  if (header.typ !== undefined && header.typ !== "JWT") throw new EnterpriseWorkloadAuthError("jwt_type_invalid");

  const key = await crypto.subtle.importKey(
    "spki",
    pemDer(options.pemPublicKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlBytes(encodedSignature),
    encoder.encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!valid) throw new EnterpriseWorkloadAuthError("jwt_signature_invalid");
  if (payload.iss !== options.expectedIssuer) throw new EnterpriseWorkloadAuthError("jwt_issuer_invalid");
  if (!audienceMatches(payload.aud, options.expectedAudience)) throw new EnterpriseWorkloadAuthError("jwt_audience_invalid");

  const now = options.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? 30;
  const maxTtl = options.maxTtlSeconds ?? 300;
  const exp = Number(payload.exp);
  const iat = Number(payload.iat);
  const nbf = payload.nbf === undefined ? iat : Number(payload.nbf);
  if (![exp, iat, nbf].every(Number.isFinite)) throw new EnterpriseWorkloadAuthError("jwt_time_claims_invalid");
  if (exp <= now - skew) throw new EnterpriseWorkloadAuthError("jwt_expired");
  if (nbf > now + skew) throw new EnterpriseWorkloadAuthError("jwt_not_yet_valid");
  if (iat > now + skew) throw new EnterpriseWorkloadAuthError("jwt_issued_in_future");
  if (exp <= iat || exp - iat > maxTtl) throw new EnterpriseWorkloadAuthError("jwt_ttl_invalid");

  if (typeof payload.sub !== "string" || !payload.sub) throw new EnterpriseWorkloadAuthError("machine_subject_required");
  if (payload.organization !== "tolani") throw new EnterpriseWorkloadAuthError("tolani_organization_required", 403);
  if (payload.access_class !== "tolani-internal") throw new EnterpriseWorkloadAuthError("internal_access_class_required", 403);
  if (typeof payload.service_id !== "string" || !payload.service_id) throw new EnterpriseWorkloadAuthError("service_identity_required", 403);
  if (options.allowedServiceIds && !options.allowedServiceIds.includes(payload.service_id)) {
    throw new EnterpriseWorkloadAuthError("service_identity_not_allowed", 403);
  }
  if (payload.environment !== options.expectedEnvironment) throw new EnterpriseWorkloadAuthError("environment_mismatch", 403);

  const normalizedScopes = scopes(payload);
  if (options.requiredScopes.some((scope) => !normalizedScopes.includes(scope))) {
    throw new EnterpriseWorkloadAuthError("service_scope_required", 403);
  }

  return Object.freeze({
    kind: "workload",
    tokenType: "clerk_m2m_jwt",
    issuer: String(payload.iss),
    subject: payload.sub,
    audience: payload.aud,
    organization: "tolani",
    accessClass: "tolani-internal",
    environment: String(payload.environment),
    serviceId: payload.service_id,
    scopes: normalizedScopes,
    issuedAt: iat,
    expiresAt: exp,
  });
}
