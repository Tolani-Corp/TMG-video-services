import {
  appendEvent,
  asRecord,
  bounded,
  loadManifest,
  workflowOf,
  writeManifest,
  type ReviewEnv,
} from "./work-review-core";
import {
  DERIVATIVE_RECIPES,
  RIGHTS_PERMITTED_USES,
  buildDerivativeAuthority,
  buildRightsVerdict,
  buildTechnicalAuthority,
  chainOf,
  setChain,
  sourceMediaFile,
  type DerivativeAuthorityEvent,
  type DerivativeRecipeId,
  type ProcessorChainDispatch,
  type ProcessorChainRecord,
  type RightsPermittedUse,
  type RightsSufficiencyVerdict,
  type RightsVerdictEvent,
  type TechnicalAuthorityEvent,
} from "./processor-chain-core";

type Operator = { email: string; name?: string | null };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

function chainView(manifest: Awaited<ReturnType<typeof loadManifest>>, dispatch?: Record<string, unknown>): Response {
  return json({
    schema: "tmg.processor-chain-review.v1.1",
    requestId: manifest?.requestId ?? null,
    status: manifest?.status ?? null,
    controls: manifest?.controls ?? null,
    processorChain: manifest ? chainOf(manifest) : null,
    dispatch: dispatch ?? null,
  });
}

function chainInstanceId(requestId: string): string {
  const left = requestId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 54);
  return `chain_${left}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`.slice(0, 96);
}

export async function startProcessorChain(env: ReviewEnv, requestId: string, operator: Operator): Promise<Response> {
  const manifest = await loadManifest(env, requestId);
  if (!manifest) return json({ error: "not_found" }, 404);
  if (manifest.status !== "action_required" || !manifest.controls.processingAuthorized) return json({ error: "processor_chain_requires_active_processing_checkpoint", status: manifest.status }, 409);
  if (manifest.controls.publicationAuthorized || manifest.controls.externalProviderEgressAuthorized) return json({ error: "processor_chain_scope_must_start_private" }, 409);
  if (manifest.review?.state !== "approved") return json({ error: "approved_human_review_required" }, 409);
  if (!new Set(["video-intelligence", "media-processing", "image-processing"]).has(manifest.request.serviceType)) return json({ error: "processor_chain_service_not_supported" }, 409);
  const preliminary = workflowOf(manifest).processorResults?.["media-inspection"];
  if (!preliminary || preliminary.schema !== "tmg.processor-result.v1") return json({ error: "media_inspection_receipt_required" }, 409);
  if (!sourceMediaFile(manifest)) return json({ error: "media_source_required" }, 409);
  const existing = chainOf(manifest);
  if (existing && !new Set(["failed", "rights_blocked", "derivative_complete"]).has(existing.state)) return json({ error: "processor_chain_already_active", state: existing.state }, 409);

  const chainId = `pc_${crypto.randomUUID()}`;
  const instanceId = chainInstanceId(manifest.requestId);
  const chain: ProcessorChainRecord = {
    schema: "tmg.processor-chain.v1.1",
    chainId,
    instanceId,
    state: "requested",
    sourceFileId: sourceMediaFile(manifest)!.fileId,
    startedBy: operator.email,
    startedAt: new Date().toISOString(),
  };
  setChain(manifest, chain);
  const workflow = workflowOf(manifest);
  workflow.processorState = "processor_chain_dispatch_requested";
  workflow.dispatchState = "chain_requested";
  workflow.headline = "Processor Chain v1.1 requested";
  workflow.summary = "The deeper codec/rights/derivative chain is being dispatched. Publication and external-provider egress remain gated.";
  appendEvent(manifest, { phase: "authorization", state: "dispatch_requested", title: "Processor Chain v1.1 dispatch requested", detail: `Chain ${chainId}; instance ${instanceId}.` });
  await writeManifest(env, manifest);

  try {
    const dispatch: ProcessorChainDispatch = { requestId: manifest.requestId, reviewId: manifest.review.reviewId, chainId, chainInstanceId: instanceId, startedBy: operator.email };
    const instance = await env.PROCESSOR_CHAIN.create({ id: instanceId, params: dispatch });
    return chainView(manifest, { workflowInstanceId: instance.id, state: "created" });
  } catch (error) {
    const latest = await loadManifest(env, requestId);
    if (latest) {
      const stored = chainOf(latest);
      if (stored?.chainId === chainId) {
        stored.state = "failed";
        setChain(latest, stored);
        const latestWorkflow = workflowOf(latest);
        latestWorkflow.processorState = "processor_chain_dispatch_failed";
        latestWorkflow.dispatchState = "checkpoint";
        appendEvent(latest, { phase: "authorization", state: "failed", title: "Processor Chain v1.1 dispatch failed", detail: error instanceof Error ? error.message : String(error) });
        await writeManifest(env, latest);
      }
    }
    return json({ error: "processor_chain_dispatch_failed" }, 502);
  }
}

export async function authorizeTechnicalInspection(request: Request, env: ReviewEnv, requestId: string, operator: Operator): Promise<Response> {
  const manifest = await loadManifest(env, requestId);
  if (!manifest) return json({ error: "not_found" }, 404);
  const chain = chainOf(manifest);
  if (!chain || chain.state !== "waiting_technical_authority") return json({ error: "technical_authority_not_expected", state: chain?.state ?? null }, 409);
  const body = asRecord(await request.json().catch(() => null));
  const note = bounded(body.note, 1000);
  if (!note || note.length < 10) return json({ error: "technical_authority_note_required" }, 400);

  const authority = buildTechnicalAuthority(manifest, chain, operator.email, note);
  chain.technicalAuthority = authority;
  setChain(manifest, chain);
  manifest.processorAuthorizations = { ...(manifest.processorAuthorizations ?? {}), "technical-inspection": authority };
  const workflow = workflowOf(manifest);
  workflow.processorAuthorizationState = "technical_authorized_event_pending";
  appendEvent(manifest, { phase: "authorization", state: "authorized", title: "Deep technical inspection authorized", detail: `Full ffprobe metadata inspection and FFmpeg decode authorized locally until ${authority.expiresAt}.` });
  await writeManifest(env, manifest);

  const eventPayload: TechnicalAuthorityEvent = { authorityId: authority.authorityId, requestId: manifest.requestId, reviewId: authority.reviewId };
  try {
    const instance = await env.PROCESSOR_CHAIN.get(chain.instanceId);
    await instance.sendEvent({ type: "technical-authorized", payload: eventPayload });
    return chainView(manifest, { eventType: "technical-authorized", authorityId: authority.authorityId, state: "sent" });
  } catch (error) {
    authority.state = "revoked";
    chain.technicalAuthority = authority;
    setChain(manifest, chain);
    appendEvent(manifest, { phase: "authorization", state: "failed", title: "Technical authority event failed", detail: error instanceof Error ? error.message : String(error) });
    await writeManifest(env, manifest);
    return json({ error: "technical_authority_event_failed" }, 502);
  }
}

function parseUses(value: unknown): RightsPermittedUse[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<string>(RIGHTS_PERMITTED_USES);
  return [...new Set(value.filter((item): item is string => typeof item === "string" && allowed.has(item)))] as RightsPermittedUse[];
}

function parseTerritories(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim().toUpperCase()).filter((item) => /^[A-Z]{2}$/.test(item)))].slice(0, 64);
}

export async function recordRightsSufficiencyVerdict(request: Request, env: ReviewEnv, requestId: string, operator: Operator): Promise<Response> {
  const manifest = await loadManifest(env, requestId);
  if (!manifest) return json({ error: "not_found" }, 404);
  const chain = chainOf(manifest);
  if (!chain || chain.state !== "waiting_rights_verdict" || !chain.technicalReceipt) return json({ error: "rights_verdict_not_expected", state: chain?.state ?? null }, 409);
  const body = asRecord(await request.json().catch(() => null));
  const state = bounded(body.state, 40) as RightsSufficiencyVerdict["state"] | null;
  if (!state || !["sufficient", "insufficient", "needs_more_evidence"].includes(state)) return json({ error: "invalid_rights_verdict_state" }, 400);
  const note = bounded(body.note, 1500);
  if (!note || note.length < 15) return json({ error: "rights_verdict_note_required" }, 400);
  const permittedUses = parseUses(body.permittedUses);
  if (state === "sufficient" && permittedUses.length === 0) return json({ error: "sufficient_verdict_requires_permitted_use" }, 400);
  const permittedTerritories = parseTerritories(body.permittedTerritories);
  const expiresAtRaw = bounded(body.expiresAt, 64);
  const expiresAt = expiresAtRaw && Number.isFinite(Date.parse(expiresAtRaw)) ? new Date(expiresAtRaw).toISOString() : null;
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) return json({ error: "rights_verdict_expiry_must_be_future" }, 400);

  const verdict = await buildRightsVerdict(manifest, chain, { state, permittedUses, permittedTerritories, expiresAt, note }, operator.email);
  chain.rightsVerdict = verdict;
  setChain(manifest, chain);
  appendEvent(manifest, { phase: "human_review", state, title: `Human rights sufficiency verdict: ${state}`, detail: `${note} Permitted uses: ${permittedUses.join(", ") || "none"}.` });
  await writeManifest(env, manifest);

  const eventPayload: RightsVerdictEvent = { verdictId: verdict.verdictId, requestId: manifest.requestId, reviewId: verdict.reviewId };
  try {
    const instance = await env.PROCESSOR_CHAIN.get(chain.instanceId);
    await instance.sendEvent({ type: "rights-verdict-recorded", payload: eventPayload });
    return chainView(manifest, { eventType: "rights-verdict-recorded", verdictId: verdict.verdictId, state: "sent" });
  } catch (error) {
    appendEvent(manifest, { phase: "human_review", state: "event_failed", title: "Rights verdict event failed", detail: error instanceof Error ? error.message : String(error) });
    await writeManifest(env, manifest);
    return json({ error: "rights_verdict_event_failed" }, 502);
  }
}

export async function authorizeDerivativeRecipe(request: Request, env: ReviewEnv, requestId: string, operator: Operator): Promise<Response> {
  const manifest = await loadManifest(env, requestId);
  if (!manifest) return json({ error: "not_found" }, 404);
  const chain = chainOf(manifest);
  if (!chain || chain.state !== "waiting_derivative_authority" || !chain.rightsVerdict || !chain.technicalReceipt) return json({ error: "derivative_authority_not_expected", state: chain?.state ?? null }, 409);
  const body = asRecord(await request.json().catch(() => null));
  const recipeId = bounded(body.recipeId, 80) as DerivativeRecipeId | null;
  if (!recipeId || !Object.prototype.hasOwnProperty.call(DERIVATIVE_RECIPES, recipeId)) return json({ error: "invalid_derivative_recipe" }, 400);
  const note = bounded(body.note, 1000);
  if (!note || note.length < 10) return json({ error: "derivative_authority_note_required" }, 400);

  let authority;
  try {
    authority = await buildDerivativeAuthority(manifest, chain, recipeId, operator.email, note);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "derivative_authority_build_failed" }, 409);
  }
  chain.derivativeAuthority = authority;
  setChain(manifest, chain);
  appendEvent(manifest, { phase: "authorization", state: "authorized", title: `${recipeId} derivative recipe authorized`, detail: `Authority is bound to technical receipt ${authority.technicalReceiptSha256.slice(0, 12)}… and rights verdict ${authority.rightsVerdictSha256.slice(0, 12)}….` });
  await writeManifest(env, manifest);

  const eventPayload: DerivativeAuthorityEvent = { authorityId: authority.authorityId, requestId: manifest.requestId, reviewId: authority.reviewId };
  try {
    const instance = await env.PROCESSOR_CHAIN.get(chain.instanceId);
    await instance.sendEvent({ type: "derivative-authorized", payload: eventPayload });
    return chainView(manifest, { eventType: "derivative-authorized", authorityId: authority.authorityId, recipeId, state: "sent" });
  } catch (error) {
    authority.state = "revoked";
    chain.derivativeAuthority = authority;
    setChain(manifest, chain);
    appendEvent(manifest, { phase: "authorization", state: "failed", title: "Derivative authority event failed", detail: error instanceof Error ? error.message : String(error) });
    await writeManifest(env, manifest);
    return json({ error: "derivative_authority_event_failed" }, 502);
  }
}
