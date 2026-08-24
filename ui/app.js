const STORAGE_KEY = "tmg.request-manifest.draft.v1";
const BOOTSTRAP_ENDPOINT = "/v1/ui/bootstrap";

const state = {
  files: [],
  bootstrap: null,
};

function $(selector, root = document) {
  return root.querySelector(selector);
}

function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${unit}`;
}

function createStatusText(enabled, on = "Configured", off = "Gated") {
  return enabled ? on : off;
}

function setText(selector, value) {
  const node = $(selector);
  if (node) node.textContent = value;
}

function setStateClass(node, active) {
  if (!node) return;
  node.classList.toggle("is-enabled", active);
  node.classList.toggle("is-gated", !active);
}

function renderBootstrap(bootstrap) {
  state.bootstrap = bootstrap;
  const runtime = bootstrap.runtime || {};

  setText("[data-policy-version]", runtime.policyVersion || "Unknown");
  setText(
    "[data-embedding-profile]",
    `${runtime.embedding?.providerId || "unknown"} · ${runtime.embedding?.dimensions || "—"}d`,
  );
  setText("[data-public-api]", createStatusText(runtime.publicApiEnabled));
  setText("[data-mcp]", createStatusText(runtime.mcpEnabled));
  setText("[data-provider-egress]", createStatusText(runtime.externalProviderEgressEnabled));

  const indicator = $("[data-service-indicator]");
  if (indicator) {
    indicator.textContent = "Connected";
    indicator.classList.add("is-live");
  }

  setText("[data-service-status]", "Operational");
  setText("[data-service-caption]", `${bootstrap.publicStatusGate || "G0"} · ${bootstrap.release?.status || "controlled"}`);
  setText("[data-op-public-api]", createStatusText(runtime.publicApiEnabled, "Enabled", "Disabled"));
  setText("[data-op-mcp]", createStatusText(runtime.mcpEnabled, "Enabled", "Disabled"));
  setText("[data-op-ingestion]", createStatusText(runtime.ingestWorkflowEnabled, "Enabled", "Disabled"));
  setText("[data-op-egress]", createStatusText(runtime.externalProviderEgressEnabled, "Enabled", "Disabled"));
  setText("[data-op-ledger]", createStatusText(runtime.tenantUsageLedgerEnabled, "Enabled", "Disabled"));

  [
    ["[data-op-public-api]", runtime.publicApiEnabled],
    ["[data-op-mcp]", runtime.mcpEnabled],
    ["[data-op-ingestion]", runtime.ingestWorkflowEnabled],
    ["[data-op-egress]", runtime.externalProviderEgressEnabled],
    ["[data-op-ledger]", runtime.tenantUsageLedgerEnabled],
  ].forEach(([selector, active]) => setStateClass($(selector)?.closest(".ops-card"), Boolean(active))));

  const stages = Array.isArray(bootstrap.release?.stages) ? bootstrap.release.stages : [];
  stages.forEach((stage) => {
    const node = $(`[data-stage="${stage.id}"]`);
    if (!node) return;
    node.classList.toggle("is-implemented", stage.state === "implemented_unactivated");
    node.classList.toggle("is-future", stage.state !== "implemented_unactivated");
    node.setAttribute(
      "aria-label",
      `${stage.id}: ${stage.state.replaceAll("_", " ")}; maximum normal traffic ${stage.normalTrafficPercentageMax} percent${stage.humanApprovalRequired ? "; human approval required" : ""}`,
    );
  });
}

async function loadBootstrap() {
  try {
    const response = await fetch(BOOTSTRAP_ENDPOINT, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error(`bootstrap_${response.status}`);
    renderBootstrap(await response.json());
  } catch (_error) {
    const indicator = $("[data-service-indicator]");
    if (indicator) {
      indicator.textContent = "Unavailable";
      indicator.classList.add("is-error");
    }
    setText("[data-service-status]", "Status unavailable");
    setText("[data-service-caption]", "The interface remains usable in local draft mode.");
  }
}

function collectFormValue(name) {
  const control = $(`[name="${name}"]`);
  if (!control) return "";
  if (control instanceof HTMLInputElement && control.type === "checkbox") return control.checked;
  return String(control.value || "").trim();
}

function selectedDeliverables() {
  return $$('input[name="deliverables"]:checked').map((input) => input.value);
}

function currentChecklist() {
  const requestName = collectFormValue("requestName");
  const businessGoal = collectFormValue("businessGoal");
  const format = collectFormValue("format");
  const duration = collectFormValue("duration");
  return {
    brief: Boolean(requestName && businessGoal),
    source: state.files.length > 0,
    rights: Boolean(collectFormValue("rightsConfirmed")),
    deliverables: selectedDeliverables().length > 0,
    profile: Boolean(format && duration),
  };
}

function renderChecklist() {
  const checklist = currentChecklist();
  Object.entries(checklist).forEach(([key, complete]) => {
    const node = $(`[data-check="${key}"]`);
    if (!node) return;
    node.classList.toggle("is-complete", complete);
    node.setAttribute("aria-current", complete ? "true" : "false");
  });

  const completeCount = Object.values(checklist).filter(Boolean).length;
  const percentage = Math.round((completeCount / Object.keys(checklist).length) * 100);
  setText("[data-readiness]", `${percentage}%`);
  const progress = $("[data-progress]");
  if (progress) progress.style.width = `${percentage}%`;

  const exportButton = $("[data-export-manifest]");
  if (exportButton) exportButton.disabled = percentage < 100;
}

function renderFiles() {
  const list = $("[data-file-list]");
  if (!list) return;
  list.replaceChildren();

  state.files.forEach((file, index) => {
    const item = document.createElement("div");
    item.className = "file-item";

    const icon = document.createElement("span");
    icon.className = "file-type";
    icon.textContent = (file.type || "FILE").split("/")[0].slice(0, 4).toUpperCase() || "FILE";

    const copy = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = file.name;
    const meta = document.createElement("small");
    meta.textContent = `${formatBytes(file.size)} · metadata only`;
    copy.append(name, meta);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "file-remove";
    remove.setAttribute("aria-label", `Remove ${file.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.files.splice(index, 1);
      renderFiles();
      persistDraft();
      renderChecklist();
    });

    item.append(icon, copy, remove);
    list.append(item);
  });
}

function fileMetadata(file) {
  return {
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream",
    lastModified: file.lastModified,
  };
}

function serializableDraft() {
  return {
    requestName: collectFormValue("requestName"),
    audience: collectFormValue("audience"),
    businessGoal: collectFormValue("businessGoal"),
    rightsConfirmed: Boolean(collectFormValue("rightsConfirmed")),
    deliverables: selectedDeliverables(),
    format: collectFormValue("format"),
    duration: collectFormValue("duration"),
    priority: collectFormValue("priority"),
    notes: collectFormValue("notes"),
    files: state.files,
  };
}

function persistDraft() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializableDraft()));
  } catch (_error) {
    // Local draft persistence is convenience-only; failure must not block the form.
  }
}

function hydrateDraft() {
  let draft;
  try {
    draft = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch (_error) {
    draft = null;
  }
  if (!draft || typeof draft !== "object") return;

  ["requestName", "audience", "businessGoal", "format", "duration", "priority", "notes"].forEach((name) => {
    const control = $(`[name="${name}"]`);
    if (control && typeof draft[name] === "string") control.value = draft[name];
  });

  const rights = $('[name="rightsConfirmed"]');
  if (rights instanceof HTMLInputElement) rights.checked = draft.rightsConfirmed === true;

  const deliverables = new Set(Array.isArray(draft.deliverables) ? draft.deliverables : []);
  $$('input[name="deliverables"]').forEach((input) => {
    if (input instanceof HTMLInputElement) input.checked = deliverables.has(input.value);
  });

  state.files = Array.isArray(draft.files)
    ? draft.files.filter((file) => file && typeof file.name === "string" && Number.isFinite(file.size)).slice(0, 50)
    : [];
  renderFiles();
}

function buildManifest() {
  const draft = serializableDraft();
  return {
    schema: "tmg.request-manifest.draft.v1",
    createdAt: new Date().toISOString(),
    status: "local-draft",
    authority: {
      publicStatusGate: "G0",
      submissionAuthority: false,
      fileTransferAuthority: false,
      processingAuthority: false,
      publicationAuthority: false,
      commercialAuthority: false,
    },
    brief: {
      name: draft.requestName,
      audience: draft.audience,
      businessGoal: draft.businessGoal,
      priority: draft.priority,
    },
    source: {
      rightsEvidenceAvailableForReview: draft.rightsConfirmed,
      files: draft.files,
      fileBytesIncluded: false,
    },
    requestedIntent: {
      deliverables: draft.deliverables,
      format: draft.format,
      targetDuration: draft.duration,
      notes: draft.notes,
    },
    governance: {
      rightsMustBeRevalidatedBeforeProcessing: true,
      derivativesDoNotExpandSourceRights: true,
      providerUseRequiresSeparateAuthority: true,
      releaseRequiresSeparateHumanApproval: true,
    },
  };
}

function safeFilename(value) {
  const cleaned = String(value || "tmg-request")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || "tmg-request";
}

function showToast(message) {
  const toast = $("[data-toast]");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.setTimeout(() => toast.classList.remove("is-visible"), 2800);
}

function exportManifest() {
  const checklist = currentChecklist();
  if (!Object.values(checklist).every(Boolean)) return;

  const manifest = buildManifest();
  const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeFilename(manifest.brief.name)}.tmg-request.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  showToast("Draft manifest exported. No media was uploaded.");
}

function resetDraft() {
  const form = $("#request-form");
  if (form instanceof HTMLFormElement) form.reset();
  state.files = [];
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (_error) {
    // Storage is optional.
  }
  renderFiles();
  renderChecklist();
  showToast("Local request draft cleared.");
}

function setupForm() {
  const form = $("#request-form");
  if (!form) return;
  hydrateDraft();

  form.addEventListener("input", () => {
    persistDraft();
    renderChecklist();
  });
  form.addEventListener("change", () => {
    persistDraft();
    renderChecklist();
  });

  const fileInput = $('[name="sourceFiles"]');
  if (fileInput instanceof HTMLInputElement) {
    fileInput.addEventListener("change", () => {
      const incoming = Array.from(fileInput.files || []).map(fileMetadata);
      const known = new Set(state.files.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
      for (const file of incoming) {
        const key = `${file.name}:${file.size}:${file.lastModified}`;
        if (!known.has(key) && state.files.length < 50) {
          state.files.push(file);
          known.add(key);
        }
      }
      fileInput.value = "";
      renderFiles();
      persistDraft();
      renderChecklist();
    });
  }

  $("[data-export-manifest]")?.addEventListener("click", exportManifest);
  $("[data-reset-draft]")?.addEventListener("click", resetDraft);
  renderChecklist();
}

function setupNavigation() {
  const toggle = $("[data-menu-toggle]");
  const nav = $("[data-nav]");
  toggle?.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!open));
    nav?.classList.toggle("is-open", !open);
  });

  $$("[data-nav] a").forEach((link) => {
    link.addEventListener("click", () => {
      toggle?.setAttribute("aria-expanded", "false");
      nav?.classList.remove("is-open");
    });
  });

  const topbar = $("[data-topbar]");
  const updateTopbar = () => topbar?.classList.toggle("is-scrolled", window.scrollY > 12);
  updateTopbar();
  window.addEventListener("scroll", updateTopbar, { passive: true });
}

function setupChoiceStates() {
  $$('input[name="deliverables"]').forEach((input) => {
    const sync = () => input.closest(".choice")?.classList.toggle("is-selected", input.checked);
    input.addEventListener("change", sync);
    sync();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  setupNavigation();
  setupForm();
  setupChoiceStates();
  loadBootstrap();
});
