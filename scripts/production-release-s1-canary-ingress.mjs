function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

const bearer = (request) => {
  const value = request.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();

    if (env.TMG_CANARY_MODE !== "s1_operator_smoke_only") {
      return json({ error: "canary_mode_rejected", requestId }, 503);
    }
    if (!env.TMG_CANARY_CONTROL_TOKEN || bearer(request) !== env.TMG_CANARY_CONTROL_TOKEN) {
      return json({ error: "canary_control_unauthorized", requestId }, 401);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        service: "tmg-video-s1-canary-ingress",
        mode: "s1_operator_smoke_only",
        persistentIngressAuthority: false,
        normalTrafficPercentage: 0,
        requestId,
      });
    }

    if (request.method !== "POST" || url.pathname !== "/internal/release/smoke") {
      return json({ error: "not_found", requestId }, 404);
    }

    const body = await request.json().catch(() => null);
    if (!body || body.stageId !== "S1") return json({ error: "stage_rejected", requestId }, 400);
    if (body.workerVersionId !== env.TMG_CANARY_TARGET_VERSION_ID) {
      return json({ error: "candidate_version_mismatch", requestId }, 400);
    }
    if (body.releaseManifestSha256 !== env.TMG_CANARY_RELEASE_MANIFEST_SHA256) {
      return json({ error: "release_manifest_mismatch", requestId }, 400);
    }
    if (body.capabilityId !== "tenant_authenticated_vector_search_canary_v1") {
      return json({ error: "capability_rejected", requestId }, 400);
    }

    const override = `tmg-video-services-production=\"${env.TMG_CANARY_TARGET_VERSION_ID}\"`;
    const targetRequest = new Request("https://tmg-video-services.internal/health", {
      method: "GET",
      headers: {
        "Cloudflare-Workers-Version-Overrides": override,
        "x-tmg-release-smoke": "s1",
      },
    });
    const response = await env.TARGET_SERVICE.fetch(targetRequest);
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload) {
      return json({ error: "candidate_health_failed", targetStatus: response.status, requestId }, 502);
    }
    if (
      payload.service !== "tmg-video-services" ||
      payload.publicStatusGate !== "G0" ||
      payload.publicApiEnabled !== false ||
      payload.mcpEnabled !== false
    ) {
      return json({ error: "candidate_fail_closed_contract_rejected", candidate: payload, requestId }, 502);
    }

    return json({
      status: "verified",
      stageId: "S1",
      workerVersionId: env.TMG_CANARY_TARGET_VERSION_ID,
      releaseManifestSha256: env.TMG_CANARY_RELEASE_MANIFEST_SHA256,
      capabilityId: "tenant_authenticated_vector_search_canary_v1",
      normalTrafficPercentage: 0,
      candidateFailClosedContract: {
        publicStatusGate: payload.publicStatusGate,
        publicApiEnabled: payload.publicApiEnabled,
        mcpEnabled: payload.mcpEnabled,
      },
      requestId,
    });
  },
};
