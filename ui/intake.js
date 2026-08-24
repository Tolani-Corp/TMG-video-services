const TMG_SESSION_ENDPOINT = "/v1/console/session";
const TMG_REQUESTS_ENDPOINT = "/v1/intake/requests";
const TMG_JOBS_ENDPOINT = "/v1/intake/jobs";
const TMG_REVIEW_QUEUE_ENDPOINT = "/v1/intake/rights/review-queue";
const TMG_LIVE_MEDIA_MAX_BYTES = 100 * 1024 * 1024;
const TMG_LIVE_EVIDENCE_MAX_BYTES = 20 * 1024 * 1024;

const liveIntake = {
  session: null,
  sourceFiles: [],
  evidenceFile: null,
  busy: false,
};

function q(selector, root = document) {
  return root.querySelector(selector);
}

function qa(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function append(parent, ...children) {
  parent.append(...children.filter(Boolean));
  return parent;
}

function formatFileBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function installIntakeStyles() {
  if (q('link[href="/intake.css"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/intake.css";
  document.head.append(link);
}

function setLiveMessage(message, state = "") {
  const node = q("[data-live-intake-progress]");
  if (!node) return;
  node.textContent = message;
  node.classList.toggle("is-error", state === "error");
  node.classList.toggle("is-success", state === "success");
}

function setLiveStatus(label, state) {
  const node = q("[data-live-intake-status]");
  if (!node) return;
  node.textContent = label;
  node.classList.toggle("is-ready", state === "ready");
  node.classList.toggle("is-hold", state === "hold");
  node.classList.toggle("is-error", state === "error");
}

function normalizedPriority() {
  const value = String(q('[name="priority"]')?.value || "Standard").toLowerCase().replace(/\s+/g, "_");
  if (value === "high") return "high";
  if (value === "critical_review") return "critical_review";
  return "standard";
}

function selectedLiveDeliverables() {
  return qa('input[name="deliverables"]:checked').map((input) => input.value);
}

function requestFormSnapshot() {
  return {
    requestName: String(q('[name="requestName"]')?.value || "").trim(),
    audience: String(q('[name="audience"]')?.value || "").trim(),
    businessGoal: String(q('[name="businessGoal"]')?.value || "").trim(),
    priority: normalizedPriority(),
    deliverables: selectedLiveDeliverables(),
    outputFormat: String(q('[name="format"]')?.value || "").trim(),
    targetDuration: String(q('[name="duration"]')?.value || "").trim(),
    notes: String(q('[name="notes"]')?.value || "").trim(),
  };
}

async function sha256File(file) {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function apiJson(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers: {
      accept: "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || body.error || `request_${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function postJson(path, body) {
  return apiJson(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function putFile(path, file, sha256) {
  const response = await fetch(path, {
    method: "PUT",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      accept: "application/json",
      "content-type": file.type || "application/octet-stream",
      "x-tmg-content-sha256": sha256,
    },
    body: file,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || body.error || `upload_${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function buildLiveIntakeCard() {
  const sticky = q(".manifest-sticky");
  if (!sticky || q("[data-live-intake-card]")) return;

  const card = element("section", "live-intake-card");
  card.dataset.liveIntakeCard = "true";
  const head = element("div", "live-intake-head");
  const copy = element("div");
  append(copy, element("strong", "", "Authenticated intake"), element("small", "", "Rights evidence moves first. Source media stays local until independent approval."));
  const status = element("span", "live-status is-hold", "Checking");
  status.dataset.liveIntakeStatus = "true";
  append(head, copy, status);

  const form = element("div", "live-form");
  const kindLabel = element("label");
  kindLabel.append(element("span", "", "Rights evidence type"));
  const kind = document.createElement("select");
  kind.dataset.liveEvidenceKind = "true";
  [
    ["license", "License"],
    ["contract", "Contract"],
    ["release", "Release"],
    ["ownership_attestation", "Ownership attestation"],
    ["synthetic_repo_owned", "Synthetic / repo-owned"],
  ].forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    kind.append(option);
  });
  kindLabel.append(kind);

  const descriptionLabel = element("label");
  descriptionLabel.append(element("span", "", "Evidence description"));
  const description = document.createElement("textarea");
  description.rows = 2;
  description.maxLength = 2000;
  description.placeholder = "Identify the agreement, ownership basis, scope, and intended internal processing authority.";
  description.dataset.liveEvidenceDescription = "true";
  descriptionLabel.append(description);

  const evidenceLabel = element("label", "live-evidence-file");
  evidenceLabel.append(element("span", "", "Rights evidence file · max 20 MB"));
  const evidenceInput = document.createElement("input");
  evidenceInput.type = "file";
  evidenceInput.accept = ".pdf,.txt,.md,image/*";
  evidenceInput.dataset.liveEvidenceFile = "true";
  evidenceLabel.append(evidenceInput);
  const evidenceMeta = element("small", "", "No evidence selected");
  evidenceMeta.dataset.liveEvidenceMeta = "true";
  evidenceLabel.append(evidenceMeta);

  const grantLabel = element("label", "live-check");
  const grant = document.createElement("input");
  grant.type = "checkbox";
  grant.dataset.liveInternalGrant = "true";
  const grantText = element("span", "", "The evidence grants TMG internal processing for this source and purpose. Independent review is still required.");
  append(grantLabel, grant, grantText);

  const derivativeLabel = element("label", "live-check");
  const derivative = document.createElement("input");
  derivative.type = "checkbox";
  derivative.dataset.liveDerivativeGrant = "true";
  append(derivativeLabel, derivative, element("span", "", "The evidence also permits derivative use for the requested deliverables."));

  const submit = element("button", "button button-primary button-block", "Submit rights-first intake");
  submit.type = "button";
  submit.dataset.liveSubmit = "true";
  submit.disabled = true;
  const progress = element("p", "live-submit-progress", "Authenticated intake is not activated on this deployment.");
  progress.dataset.liveIntakeProgress = "true";
  const note = element("p", "live-submit-note", "Controlled v1 accepts exactly one source media file per live submission. Multi-source planning remains available through the local manifest export. Source bytes are not sent until another authenticated operator verifies the rights package.");

  append(form, kindLabel, descriptionLabel, evidenceLabel, grantLabel, derivativeLabel, submit, progress, note);
  append(card, head, form);
  sticky.append(card);

  evidenceInput.addEventListener("change", () => {
    liveIntake.evidenceFile = evidenceInput.files?.[0] || null;
    evidenceInput.value = "";
    evidenceMeta.textContent = liveIntake.evidenceFile
      ? `${liveIntake.evidenceFile.name} · ${formatFileBytes(liveIntake.evidenceFile.size)}`
      : "No evidence selected";
    updateLiveSubmitState();
  });
  submit.addEventListener("click", submitRightsFirstIntake);
}

function captureSourceFiles() {
  document.addEventListener(
    "change",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || target.name !== "sourceFiles") return;
      liveIntake.sourceFiles = Array.from(target.files || []);
      updateLiveSubmitState();
    },
    true,
  );
}

function updateLiveSubmitState() {
  const button = q("[data-live-submit]");
  if (!button) return;
  const enabled = Boolean(liveIntake.session?.intake?.enabled);
  const source = liveIntake.sourceFiles.length === 1 ? liveIntake.sourceFiles[0] : null;
  const evidence = liveIntake.evidenceFile;
  const form = requestFormSnapshot();
  const acknowledged = q('[name="rightsConfirmed"]')?.checked === true;
  const internalGrant = q("[data-live-internal-grant]")?.checked === true;
  const complete = Boolean(
    enabled &&
      source &&
      evidence &&
      source.size <= TMG_LIVE_MEDIA_MAX_BYTES &&
      evidence.size <= TMG_LIVE_EVIDENCE_MAX_BYTES &&
      form.requestName &&
      form.businessGoal &&
      form.deliverables.length > 0 &&
      form.outputFormat &&
      form.targetDuration &&
      acknowledged &&
      internalGrant &&
      !liveIntake.busy,
  );
  button.disabled = !complete;
}

async function submitRightsFirstIntake() {
  if (liveIntake.busy) return;
  const source = liveIntake.sourceFiles[0];
  const evidenceFile = liveIntake.evidenceFile;
  if (!source || !evidenceFile || liveIntake.sourceFiles.length !== 1) return;
  if (!/^(video|audio|image)\//.test(source.type || "")) {
    setLiveMessage("Live intake currently accepts video, audio, or image source media only.", "error");
    return;
  }

  liveIntake.busy = true;
  updateLiveSubmitState();
  try {
    setLiveMessage("Hashing source and rights evidence locally. No source bytes are moving yet.");
    const [sourceSha, evidenceSha] = await Promise.all([sha256File(source), sha256File(evidenceFile)]);
    const snapshot = requestFormSnapshot();

    setLiveMessage("Creating authenticated request record…");
    const created = await postJson(TMG_REQUESTS_ENDPOINT, snapshot);
    const requestId = created.request.requestId;

    setLiveMessage("Registering source integrity metadata…");
    const assetResponse = await postJson(`/v1/intake/requests/${encodeURIComponent(requestId)}/assets`, {
      filename: source.name,
      mimeType: source.type,
      expectedBytes: source.size,
      expectedSha256: sourceSha,
    });
    const assetId = assetResponse.asset.assetId;

    setLiveMessage("Registering rights evidence metadata…");
    const rightsResponse = await postJson(`/v1/intake/assets/${encodeURIComponent(assetId)}/rights`, {
      evidenceKind: q("[data-live-evidence-kind]")?.value || "ownership_attestation",
      description: String(q("[data-live-evidence-description]")?.value || "").trim(),
      filename: evidenceFile.name,
      mimeType: evidenceFile.type || "application/octet-stream",
      expectedBytes: evidenceFile.size,
      expectedSha256: evidenceSha,
      grantsInternalProcessing: q("[data-live-internal-grant]")?.checked === true,
      grantsDerivativeUse: q("[data-live-derivative-grant]")?.checked === true,
      grantsExternalProviderEvaluation: false,
    });
    const evidenceId = rightsResponse.rightsEvidence.evidenceId;

    setLiveMessage("Uploading rights evidence to private R2 with SHA-256 enforcement…");
    await putFile(`/v1/intake/rights/${encodeURIComponent(evidenceId)}/evidence`, evidenceFile, evidenceSha);

    setLiveMessage(
      `Request ${requestId} is awaiting independent rights review. Source media remains local and has not been uploaded.`,
      "success",
    );
    liveIntake.evidenceFile = null;
    await loadWorkspace();
  } catch (error) {
    setLiveMessage(error instanceof Error ? error.message : "Authenticated intake failed.", "error");
  } finally {
    liveIntake.busy = false;
    updateLiveSubmitState();
  }
}

function buildWorkspace() {
  if (q("#workspace")) return;
  const operations = q("#operations");
  if (!operations) return;
  const section = element("section", "section-shell workspace-section");
  section.id = "workspace";
  section.setAttribute("aria-labelledby", "workspace-title");

  const head = element("div", "workspace-head");
  const titleCopy = element("div");
  append(titleCopy, element("div", "eyebrow", "Authenticated workspace"));
  const title = element("h2", "", "Requests, rights review, and blocked jobs.");
  title.id = "workspace-title";
  titleCopy.append(title);
  titleCopy.append(element("p", "", "Every row is backend-derived. A completed quarantine is evidence readiness, not processing authority."));
  const actions = element("div", "workspace-actions");
  const identity = element("span", "workspace-identity", "Not authenticated");
  identity.dataset.workspaceIdentity = "true";
  const refresh = element("button", "button button-secondary", "Refresh workspace");
  refresh.type = "button";
  refresh.dataset.workspaceRefresh = "true";
  refresh.addEventListener("click", loadWorkspace);
  append(actions, identity, refresh);
  append(head, titleCopy, actions);

  const grid = element("div", "workspace-grid");
  const requestColumn = element("div", "workspace-column");
  requestColumn.dataset.workspaceRequests = "true";
  requestColumn.append(element("div", "empty-state", "Authenticated request records will appear here when intake is activated."));
  const reviewColumn = element("div", "workspace-column");
  reviewColumn.dataset.workspaceReviews = "true";
  reviewColumn.append(element("div", "empty-state", "Independent rights review queue is unavailable until intake activation."));
  append(grid, requestColumn, reviewColumn);
  append(section, head, grid);
  operations.parentNode.insertBefore(section, operations);

  const nav = q("[data-nav]");
  if (nav && !q('a[href="#workspace"]', nav)) {
    const link = document.createElement("a");
    link.href = "#workspace";
    link.textContent = "Workspace";
    nav.insertBefore(link, nav.querySelector('a[href="#operations"]'));
  }
}

async function loadSession() {
  try {
    const response = await apiJson(TMG_SESSION_ENDPOINT);
    liveIntake.session = response;
    const identity = q("[data-workspace-identity]");
    if (identity) identity.textContent = response.actor?.email || "Authenticated";
    if (response.intake?.enabled) {
      setLiveStatus("Access verified", "ready");
      setLiveMessage("Authenticated intake is available. Source upload remains rights-gated.");
    } else {
      setLiveStatus("Infrastructure hold", "hold");
      setLiveMessage("Access is authenticated, but durable intake is not activated on this deployment.");
    }
  } catch (error) {
    liveIntake.session = null;
    const status = error?.status === 403 ? "Access required" : "Not activated";
    setLiveStatus(status, error?.status === 403 ? "error" : "hold");
    setLiveMessage("Local draft/export remains available. Authenticated intake has not been activated here.");
  }
  updateLiveSubmitState();
}

function statusPill(value, goodValues = []) {
  const pill = element("span", `workspace-pill ${goodValues.includes(value) ? "is-ok" : "is-hold"}`, String(value || "unknown").replaceAll("_", " "));
  return pill;
}

async function fetchRequestBundles() {
  const listing = await apiJson(TMG_REQUESTS_ENDPOINT);
  const requests = Array.isArray(listing.requests) ? listing.requests.slice(0, 30) : [];
  return Promise.all(
    requests.map((item) => apiJson(`/v1/intake/requests/${encodeURIComponent(item.requestId)}`)),
  );
}

function renderRequestBundles(bundles) {
  const column = q("[data-workspace-requests]");
  if (!column) return;
  column.replaceChildren();
  const heading = element("div", "workspace-row-head");
  append(heading, element("h3", "", "My governed requests"), element("span", "live-status", `${bundles.length} records`));
  column.append(heading);

  if (bundles.length === 0) {
    column.append(element("div", "empty-state", "No authenticated requests yet. The local request builder remains available above."));
    return;
  }

  bundles.forEach((bundle) => {
    const request = bundle.request;
    const card = element("article", `workspace-card ${request.status === "rejected" ? "is-rejected" : ""}`);
    const head = element("div", "workspace-row-head");
    const copy = element("div");
    append(copy, element("h3", "", request.requestName), element("small", "", request.requestId));
    append(head, copy, statusPill(request.status, ["ready_for_operator_review", "rights_verified"]));
    card.append(head);
    const meta = element("div", "workspace-meta");
    append(meta, statusPill(request.priority), statusPill(`processing ${request.authority.processing ? "authorized" : "blocked"}`));
    card.append(meta);

    (bundle.assets || []).forEach((asset) => card.append(buildAssetRow(bundle, asset)));
    (bundle.jobs || []).forEach((job) => card.append(buildJobRow(job)));

    const assetsReady = (bundle.assets || []).length > 0 && (bundle.assets || []).every(
      (asset) => asset.rightsState === "verified" && asset.uploadState === "quarantined_integrity_verified",
    );
    const hasJob = (bundle.jobs || []).length > 0;
    if (assetsReady && !hasJob) {
      const actions = element("div", "asset-actions");
      const createJob = element("button", "mini-button", "Create blocked job record");
      createJob.type = "button";
      createJob.addEventListener("click", async () => {
        createJob.disabled = true;
        try {
          await postJson(`/v1/intake/requests/${encodeURIComponent(request.requestId)}/jobs`, {
            acknowledgement: "processing-authority-remains-blocked-at-g0",
          });
          await loadWorkspace();
        } catch (error) {
          setLiveMessage(error instanceof Error ? error.message : "Job creation failed.", "error");
          createJob.disabled = false;
        }
      });
      actions.append(createJob);
      card.append(actions);
    }
    column.append(card);
  });
}

function buildAssetRow(bundle, asset) {
  const row = element("div", "asset-row");
  const title = element("div", "asset-title");
  const name = element("strong", "", asset.filename);
  const state = element("span", "", `${asset.rightsState.replaceAll("_", " ")} · ${asset.uploadState.replaceAll("_", " ")}`);
  append(title, name, state);
  row.append(title);
  const meta = element("div", "workspace-meta");
  append(meta, statusPill(asset.rightsState, ["verified"]), statusPill(asset.uploadState, ["quarantined_integrity_verified"]), statusPill(`processable ${asset.processable ? "yes" : "no"}`));
  row.append(meta);

  if (asset.rightsState === "verified" && asset.uploadState === "metadata_registered") {
    const actions = element("div", "asset-actions");
    const input = document.createElement("input");
    input.type = "file";
    input.accept = `${asset.mimeType}`;
    input.setAttribute("aria-label", `Reselect ${asset.filename} for private quarantine upload`);
    const upload = element("button", "mini-button", "Integrity-check → quarantine");
    upload.type = "button";
    upload.disabled = true;
    let selected = null;
    input.addEventListener("change", () => {
      selected = input.files?.[0] || null;
      upload.disabled = !selected;
    });
    upload.addEventListener("click", async () => {
      if (!selected) return;
      upload.disabled = true;
      try {
        if (selected.size !== asset.expectedBytes || selected.type !== asset.mimeType) {
          throw new Error("Reselected source does not match registered size/type.");
        }
        setLiveMessage(`Hashing ${selected.name} locally before quarantine upload…`);
        const hash = await sha256File(selected);
        if (hash.toLowerCase() !== asset.expectedSha256.toLowerCase()) {
          throw new Error("Reselected source SHA-256 does not match the registered asset.");
        }
        await putFile(`/v1/intake/assets/${encodeURIComponent(asset.assetId)}/quarantine`, selected, hash);
        setLiveMessage("Source is integrity-verified in private quarantine. Processing authority remains blocked.", "success");
        await loadWorkspace();
      } catch (error) {
        setLiveMessage(error instanceof Error ? error.message : "Quarantine upload failed.", "error");
        upload.disabled = false;
      }
    });
    append(actions, input, upload);
    row.append(actions);
  }
  return row;
}

function buildJobRow(job) {
  const row = element("div", "job-row");
  const title = element("div", "asset-title");
  append(title, element("strong", "", job.jobId), element("span", "", job.status.replaceAll("_", " ")));
  row.append(title);
  const meta = element("div", "workspace-meta");
  append(meta, statusPill(job.workflowState), statusPill(`processing ${job.processingAuthority ? "authorized" : "blocked"}`), statusPill(`billable ${job.billable ? "yes" : "no"}`));
  row.append(meta);
  return row;
}

async function loadReviewQueue() {
  const result = await apiJson(TMG_REVIEW_QUEUE_ENDPOINT);
  return Array.isArray(result.rightsEvidence) ? result.rightsEvidence : [];
}

function renderReviewQueue(items) {
  const column = q("[data-workspace-reviews]");
  if (!column) return;
  column.replaceChildren();
  const heading = element("div", "workspace-row-head");
  append(heading, element("h3", "", "Independent rights review"), element("span", "live-status", `${items.length} pending`));
  column.append(heading);
  if (items.length === 0) {
    column.append(element("div", "empty-state", "No checksum-verified rights packages from other operators are awaiting review."));
    return;
  }

  items.forEach((item) => {
    const card = element("article", "review-card");
    const head = element("div", "review-head");
    const copy = element("div");
    append(copy, element("h3", "", item.filename), element("small", "", item.evidenceId));
    append(head, copy, statusPill(item.reviewState));
    card.append(head);
    card.append(element("p", "review-copy", item.description));
    const meta = element("div", "workspace-meta");
    append(
      meta,
      statusPill(item.evidenceKind),
      statusPill(item.uploadState, ["integrity_verified"]),
      statusPill(`internal ${item.grants.internalProcessing ? "granted" : "not granted"}`, ["internal granted"]),
      statusPill(`derivative ${item.grants.derivativeUse ? "granted" : "not granted"}`, ["derivative granted"]),
    );
    card.append(meta);
    const submitted = element("p", "review-copy", `Submitted by ${item.submittedBy}`);
    card.append(submitted);
    const actions = element("div", "review-actions");
    const download = element("a", "mini-link", "Inspect evidence file");
    download.href = `/v1/intake/rights/${encodeURIComponent(item.evidenceId)}/evidence-file`;
    download.target = "_blank";
    download.rel = "noopener";
    const approve = element("button", "mini-button", "Verify rights");
    approve.type = "button";
    approve.disabled = !item.grants.internalProcessing;
    approve.title = item.grants.internalProcessing ? "Verify this processing grant" : "This evidence does not claim internal processing authority";
    const reject = element("button", "mini-button is-danger", "Reject");
    reject.type = "button";
    approve.addEventListener("click", () => reviewRights(item, "verify", approve, reject));
    reject.addEventListener("click", () => reviewRights(item, "reject", reject, approve));
    append(actions, download, approve, reject);
    card.append(actions);
    column.append(card);
  });
}

async function reviewRights(item, decision, primaryButton, secondaryButton) {
  primaryButton.disabled = true;
  secondaryButton.disabled = true;
  const defaultRationale = decision === "verify"
    ? "Authenticated independent review confirms the submitted evidence grants the stated internal processing purpose."
    : "Authenticated independent review rejected this rights package.";
  try {
    await postJson(`/v1/intake/rights/${encodeURIComponent(item.evidenceId)}/review`, {
      decision,
      rationale: defaultRationale,
    });
    setLiveMessage(`Rights evidence ${decision === "verify" ? "verified" : "rejected"} by independent operator.`, decision === "verify" ? "success" : "error");
    await loadWorkspace();
  } catch (error) {
    setLiveMessage(error instanceof Error ? error.message : "Rights review failed.", "error");
    primaryButton.disabled = false;
    secondaryButton.disabled = false;
  }
}

async function loadWorkspace() {
  if (!liveIntake.session?.intake?.enabled) {
    return;
  }
  const refresh = q("[data-workspace-refresh]");
  if (refresh) refresh.disabled = true;
  try {
    const [bundles, reviews] = await Promise.all([fetchRequestBundles(), loadReviewQueue()]);
    renderRequestBundles(bundles);
    renderReviewQueue(reviews);
  } catch (error) {
    setLiveMessage(error instanceof Error ? error.message : "Workspace refresh failed.", "error");
  } finally {
    if (refresh) refresh.disabled = false;
  }
}

async function initializeAuthenticatedIntake() {
  installIntakeStyles();
  captureSourceFiles();
  buildLiveIntakeCard();
  buildWorkspace();
  qa("#request-form input, #request-form select, #request-form textarea").forEach((control) => {
    control.addEventListener("change", updateLiveSubmitState);
    control.addEventListener("input", updateLiveSubmitState);
  });
  await loadSession();
  await loadWorkspace();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeAuthenticatedIntake, { once: true });
} else {
  void initializeAuthenticatedIntake();
}
