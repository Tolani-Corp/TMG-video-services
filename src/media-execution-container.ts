import { Container } from "@cloudflare/containers";
import type { ReviewEnv } from "./work-review-core";

function decodeKey(url: URL): string | null {
  const match = url.pathname.match(/^\/object\/(.+)$/);
  if (!match) return null;
  try {
    const key = decodeURIComponent(match[1]!);
    if (!key || key.length > 900 || key.includes("..") || key.includes("\\") || /[\u0000-\u001f\u007f]/.test(key)) return null;
    return key;
  } catch {
    return null;
  }
}

function reviewEnv(env: Env): ReviewEnv {
  return env as unknown as ReviewEnv;
}

function metadataHeaders(object: R2Object): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("content-length", String(object.size));
  const sha256 = object.customMetadata?.sha256;
  if (sha256) headers.set("x-tmg-sha256", sha256);
  headers.set("cache-control", "private, no-store");
  return headers;
}

async function workRequestR2(request: Request, rawEnv: Env): Promise<Response> {
  const env = reviewEnv(rawEnv);
  const url = new URL(request.url);
  const key = decodeKey(url);
  if (!key || !key.startsWith("quarantine/")) return new Response("invalid_key", { status: 400 });
  if (request.method === "HEAD") {
    const object = await env.WORK_REQUESTS.head(key);
    return object ? new Response(null, { status: 200, headers: metadataHeaders(object) }) : new Response(null, { status: 404 });
  }
  if (request.method !== "GET") return new Response("method_not_allowed", { status: 405 });
  const object = await env.WORK_REQUESTS.get(key);
  if (!object) return new Response("not_found", { status: 404 });
  return new Response(object.body, { headers: metadataHeaders(object) });
}

async function derivativeR2(request: Request, rawEnv: Env): Promise<Response> {
  const env = reviewEnv(rawEnv);
  const url = new URL(request.url);
  const key = decodeKey(url);
  if (!key || !key.startsWith("derived/")) return new Response("invalid_key", { status: 400 });

  if (request.method === "PUT") {
    const sha256 = request.headers.get("x-tmg-sha256")?.trim().toLowerCase() ?? "";
    const contentType = request.headers.get("content-type")?.trim() || "application/octet-stream";
    if (!/^[a-f0-9]{64}$/.test(sha256) || !request.body) return new Response("sha256_and_body_required", { status: 400 });
    const stored = await env.DERIVATIVES.put(key, request.body, {
      sha256,
      httpMetadata: { contentType, cacheControl: "private, no-store" },
      customMetadata: { sha256, posture: "private_derivative_unpublished" },
    });
    return Response.json({ ok: true, key, size: stored?.size ?? null, etag: stored?.etag ?? null, sha256 });
  }

  if (request.method === "HEAD") {
    const object = await env.DERIVATIVES.head(key);
    return object ? new Response(null, { status: 200, headers: metadataHeaders(object) }) : new Response(null, { status: 404 });
  }

  if (request.method === "GET") {
    const object = await env.DERIVATIVES.get(key);
    if (!object) return new Response("not_found", { status: 404 });
    return new Response(object.body, { headers: metadataHeaders(object) });
  }

  return new Response("method_not_allowed", { status: 405 });
}

export class MediaExecutionContainer extends Container<ReviewEnv> {
  defaultPort = 8080;
  sleepAfter = "5m";
  enableInternet = false;

  static outboundByHost = {
    "work-requests.r2": workRequestR2,
    "derivatives.r2": derivativeR2,
  };
}
