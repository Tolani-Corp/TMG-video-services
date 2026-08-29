const syncRoot = document.querySelector('[data-sync-state]');
const syncLabel = document.querySelector('[data-sync-label]');
const backendStatus = document.querySelector('[data-backend-status]');
const gate = document.querySelector('[data-gate]');
const policy = document.querySelector('[data-policy]');
const api = document.querySelector('[data-api]');
const mcp = document.querySelector('[data-mcp]');
const ingestion = document.querySelector('[data-ingestion]');
const egress = document.querySelector('[data-egress]');
const syncedAt = document.querySelector('[data-synced-at]');

const requestForm = document.querySelector('[data-work-request-form]');
const fileInput = document.querySelector('[data-file-input]');
const fileList = document.querySelector('[data-file-list]');
const dropzone = document.querySelector('[data-dropzone]');
const submitRequest = document.querySelector('[data-submit-request]');
const intakeState = document.querySelector('[data-intake-state]');
const progressShell = document.querySelector('[data-progress]');
const progressBar = document.querySelector('[data-progress-bar]');
const progressText = document.querySelector('[data-progress-text]');
const receipt = document.querySelector('[data-receipt]');

const processingConsole = document.querySelector('[data-processing-console]');
const processingReference = document.querySelector('[data-processing-reference]');
const processingLive = document.querySelector('[data-processing-live]');
const processingPercent = document.querySelector('[data-processing-percent]');
const processingPhase = document.querySelector('[data-processing-phase]');
const processingHeadline = document.querySelector('[data-processing-headline]');
const processingSummary = document.querySelector('[data-processing-summary]');
const processingUpdated = document.querySelector('[data-processing-updated]');
const processingFiles = document.querySelector('[data-processing-files]');
const processingAuthority = document.querySelector('[data-processing-authority]');
const processingPublication = document.querySelector('[data-processing-publication]');
const processingEgress = document.querySelector('[data-processing-egress]');
const processingEvents = document.querySelector('[data-processing-events]');
const processingOutcome = document.querySelector('[data-processing-outcome]');
const outcomeHeadline = document.querySelector('[data-outcome-headline]');
const outcomeSummary = document.querySelector('[data-outcome-summary]');
const outcomeEvidence = document.querySelector('[data-outcome-evidence]');
const outcomeDeliverables = document.querySelector('[data-outcome-deliverables]');
const outcomeNextAction = document.querySelector('[data-outcome-next-action]');
const pauseUpdates = document.querySelector('[data-processing-pause]');
const refreshProcessing = document.querySelector('[data-processing-refresh]');
const copyReference = document.querySelector('[data-processing-copy]');
const downloadSnapshot = document.querySelector('[data-processing-download]');
const newRequest = document.querySelector('[data-processing-new-request]');

const TRACKING_KEY = 'tmg-work-request-tracking-v1';
let intakeConfig = null;
let selectedFiles = [];
let tracking = {
  requestId: null,
  token: null,
  paused: false,
  timer: null,
  lastStatus: null,
  inFlight: false,
};

function setText(node, value) {
  if (node) node.textContent = value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function runtimeLabel(value) {
  if (value === true) return 'Enabled';
  if (value === false) return 'Gated';
  return 'Not exposed by current backend';
}

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function mimeForFile(file) {
  if (file.type) return file.type.toLowerCase();
  const extension = file.name.toLowerCase().split('.').pop();
  const map = {
    pdf: 'application/pdf', json: 'application/json', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime',
  };
  return map[extension] || 'application/octet-stream';
}

function renderFiles() {
  if (!fileList) return;
  fileList.replaceChildren();
  selectedFiles.forEach((file, index) => {
    const item = document.createElement('li');
    const copy = document.createElement('span');
    copy.textContent = `${file.name} · ${humanBytes(file.size)}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'file-remove';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      selectedFiles.splice(index, 1);
      renderFiles();
    });
    item.append(copy, remove);
    fileList.append(item);
  });
}

function setProgress(percent, message) {
  if (progressShell) progressShell.hidden = false;
  if (progressBar) progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  setText(progressText, message);
}

function showReceipt(html, kind = 'success') {
  if (!receipt) return;
  receipt.hidden = false;
  receipt.dataset.kind = kind;
  receipt.innerHTML = html;
}

function saveTracking() {
  if (!tracking.requestId || !tracking.token) return;
  try {
    sessionStorage.setItem(TRACKING_KEY, JSON.stringify({ requestId: tracking.requestId, token: tracking.token }));
  } catch {
    // Session persistence is optional; live tracking still works in-memory.
  }
}

function clearTracking() {
  if (tracking.timer) clearTimeout(tracking.timer);
  tracking = { requestId: null, token: null, paused: false, timer: null, lastStatus: null, inFlight: false };
  try {
    sessionStorage.removeItem(TRACKING_KEY);
  } catch {
    // Ignore storage failures.
  }
  if (processingConsole) processingConsole.hidden = true;
}

function restoreTracking() {
  try {
    const raw = sessionStorage.getItem(TRACKING_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (typeof saved?.requestId === 'string' && typeof saved?.token === 'string') {
      startLiveTracking(saved.requestId, saved.token, false);
    }
  } catch {
    try { sessionStorage.removeItem(TRACKING_KEY); } catch { /* no-op */ }
  }
}

function liveLabel(status) {
  if (tracking.paused) return 'Live updates paused';
  const state = status?.lifecycle?.state;
  if (state === 'terminal') return 'Final state recorded';
  if (state === 'action_required') return 'Action checkpoint';
  if (state === 'waiting') return 'Watching for workflow updates';
  return 'Live workflow telemetry';
}

function renderStageRail(stages) {
  const stageNodes = document.querySelectorAll('[data-processing-stage]');
  stageNodes.forEach((node) => {
    const key = node.getAttribute('data-processing-stage');
    const stage = Array.isArray(stages) ? stages.find((item) => item?.key === key) : null;
    node.dataset.stageState = stage?.state || 'pending';
    const stateNode = node.querySelector('[data-stage-state]');
    if (stateNode) stateNode.textContent = stage?.state === 'complete' ? 'Complete' : stage?.state === 'active' ? 'Active' : stage?.state === 'blocked' ? 'Closed' : 'Pending';
  });
}

function renderEvents(events, fallback) {
  if (!processingEvents) return;
  processingEvents.replaceChildren();
  const visible = Array.isArray(events) && events.length ? events.slice().reverse() : [{
    title: fallback?.lifecycle?.headline || 'Waiting for workflow evidence',
    detail: fallback?.lifecycle?.summary || 'No workflow event has been recorded yet.',
    at: fallback?.updatedAt,
    state: fallback?.lifecycle?.state || 'waiting',
  }];

  visible.forEach((event) => {
    const item = document.createElement('li');
    item.className = 'event-item';
    const marker = document.createElement('span');
    marker.className = 'event-marker';
    marker.dataset.eventState = event?.state || 'observed';
    const body = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'event-head';
    const title = document.createElement('strong');
    title.textContent = event?.title || 'Workflow update';
    const time = document.createElement('time');
    time.textContent = event?.at ? new Date(event.at).toLocaleString() : 'Now';
    head.append(title, time);
    const detail = document.createElement('p');
    detail.textContent = event?.detail || '';
    body.append(head, detail);
    item.append(marker, body);
    processingEvents.append(item);
  });
}

function renderKeyValueList(node, items, emptyText) {
  if (!node) return;
  node.replaceChildren();
  if (!Array.isArray(items) || items.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = emptyText;
    node.append(empty);
    return;
  }
  items.forEach((item) => {
    const li = document.createElement('li');
    const label = document.createElement('strong');
    label.textContent = item?.label || 'Item';
    const value = document.createElement('span');
    value.textContent = item?.value || item?.status || 'Recorded';
    li.append(label, value);
    node.append(li);
  });
}

function renderOutcome(status) {
  if (!processingOutcome) return;
  const outcome = status?.outcome;
  const shouldShow = Boolean(outcome) || status?.lifecycle?.state === 'terminal' || status?.lifecycle?.state === 'action_required';
  processingOutcome.hidden = !shouldShow;
  if (!shouldShow) return;

  setText(outcomeHeadline, outcome?.headline || status?.lifecycle?.headline || 'Outcome pending');
  setText(outcomeSummary, outcome?.summary || status?.lifecycle?.summary || 'No outcome summary has been recorded yet.');
  renderKeyValueList(outcomeEvidence, outcome?.evidence, 'No outcome evidence has been published to this view yet.');
  renderKeyValueList(outcomeDeliverables, outcome?.deliverables, 'No deliverables are available in this view yet.');
  if (outcomeNextAction) {
    outcomeNextAction.hidden = !outcome?.nextAction;
    setText(outcomeNextAction, outcome?.nextAction || '');
  }
}

function renderProcessingStatus(status) {
  tracking.lastStatus = status;
  if (processingConsole) {
    processingConsole.hidden = false;
    processingConsole.dataset.processingState = status?.lifecycle?.state || 'waiting';
  }
  setText(processingReference, status?.requestId || tracking.requestId || '—');
  setText(processingLive, liveLabel(status));
  setText(processingPercent, `${Number(status?.lifecycle?.progress || 0)}%`);
  setText(processingPhase, String(status?.lifecycle?.phase || status?.status || 'waiting').replaceAll('_', ' '));
  setText(processingHeadline, status?.lifecycle?.headline || 'Workflow status unavailable');
  setText(processingSummary, status?.lifecycle?.summary || 'The current request state could not be summarized.');
  setText(processingUpdated, status?.updatedAt ? new Date(status.updatedAt).toLocaleString() : 'Unknown');

  const files = status?.context?.files;
  setText(processingFiles, files ? `${files.uploaded}/${files.total} secured` : '—');
  setText(processingAuthority, status?.context?.controls?.processingAuthorized ? 'Authorized' : 'Gated');
  setText(processingPublication, status?.context?.controls?.publicationAuthorized ? 'Authorized' : 'Gated');
  setText(processingEgress, status?.context?.controls?.externalProviderEgressAuthorized ? 'Authorized' : 'Gated');

  const ring = document.querySelector('[data-processing-ring]');
  if (ring) ring.style.setProperty('--processing-progress', `${Math.max(0, Math.min(100, Number(status?.lifecycle?.progress || 0)))}%`);
  renderStageRail(status?.lifecycle?.stages);
  renderEvents(status?.events, status);
  renderOutcome(status);
  if (pauseUpdates) pauseUpdates.textContent = tracking.paused ? 'Resume live updates' : 'Pause live updates';
}

function nextPollDelay(status) {
  if (tracking.paused || status?.lifecycle?.state === 'terminal') return 0;
  if (status?.lifecycle?.state === 'waiting') return 12000;
  return 5000;
}

function scheduleProcessingPoll(status) {
  if (tracking.timer) clearTimeout(tracking.timer);
  tracking.timer = null;
  const delay = nextPollDelay(status);
  if (delay > 0) tracking.timer = setTimeout(() => pollProcessingStatus(false), delay);
}

async function pollProcessingStatus(force = false) {
  if (!tracking.requestId || !tracking.token || tracking.inFlight) return;
  if (tracking.paused && !force) return;
  tracking.inFlight = true;
  try {
    const response = await fetch(`/work-requests/${encodeURIComponent(tracking.requestId)}/status`, {
      headers: { accept: 'application/json', 'x-work-request-token': tracking.token },
      cache: 'no-store',
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 429) {
        setText(processingLive, 'Live updates throttled · retrying');
        if (tracking.timer) clearTimeout(tracking.timer);
        tracking.timer = setTimeout(() => pollProcessingStatus(false), 15000);
        return;
      }
      throw new Error(body.error || `status ${response.status}`);
    }
    renderProcessingStatus(body);
    scheduleProcessingPoll(body);
  } catch (error) {
    setText(processingLive, 'Live status temporarily unavailable');
    setText(processingSummary, error instanceof Error ? error.message : 'Unable to refresh workflow state.');
    if (!tracking.paused) {
      if (tracking.timer) clearTimeout(tracking.timer);
      tracking.timer = setTimeout(() => pollProcessingStatus(false), 15000);
    }
  } finally {
    tracking.inFlight = false;
  }
}

function startLiveTracking(requestId, token, scroll = true) {
  if (!requestId || !token) return;
  if (tracking.timer) clearTimeout(tracking.timer);
  tracking.requestId = requestId;
  tracking.token = token;
  tracking.paused = false;
  tracking.timer = null;
  tracking.lastStatus = null;
  saveTracking();
  if (processingConsole) {
    processingConsole.hidden = false;
    processingConsole.dataset.processingState = 'active';
  }
  setText(processingReference, requestId);
  setText(processingLive, 'Connecting to live workflow status…');
  if (scroll && processingConsole) processingConsole.scrollIntoView({ behavior: 'smooth', block: 'start' });
  pollProcessingStatus(true);
}

async function syncStatus() {
  try {
    const response = await fetch('/status.json', { headers: { accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const status = await response.json();
    const healthy = status?.backend?.status === 'reachable';
    const contract = status?.backend?.syncContract ?? 'unknown-contract';
    if (syncRoot) syncRoot.dataset.syncState = healthy ? 'healthy' : 'degraded';
    setText(syncLabel, healthy ? 'Backend synchronized' : 'Backend degraded');
    setText(backendStatus, healthy ? `Reachable via private Worker binding · ${contract}` : 'Degraded');
    setText(gate, status?.backend?.publicStatusGate ?? 'Unknown');
    setText(policy, status?.backend?.policyVersion ?? 'Unknown');
    setText(api, runtimeLabel(status?.runtime?.publicApiEnabled));
    setText(mcp, runtimeLabel(status?.runtime?.mcpEnabled));
    setText(ingestion, runtimeLabel(status?.runtime?.ingestWorkflowEnabled));
    setText(egress, runtimeLabel(status?.runtime?.externalProviderEgressEnabled));
    setText(syncedAt, status?.synchronizedAt ? new Date(status.synchronizedAt).toLocaleString() : 'Unknown');
  } catch {
    if (syncRoot) syncRoot.dataset.syncState = 'degraded';
    setText(syncLabel, 'Backend sync unavailable');
    setText(backendStatus, 'Unavailable');
  }
}

async function loadIntakeConfig() {
  if (!requestForm) return;
  try {
    const response = await fetch('/work-requests/config', { headers: { accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`config ${response.status}`);
    intakeConfig = await response.json();
    const enabled = intakeConfig?.enabled === true;
    if (submitRequest) submitRequest.disabled = !enabled;
    setText(intakeState, enabled ? 'Secure intake online · uploads go to private quarantine' : 'Work request intake is temporarily closed');
  } catch {
    if (submitRequest) submitRequest.disabled = true;
    setText(intakeState, 'Unable to verify intake availability');
  }
}

function addFiles(files) {
  if (!intakeConfig) return;
  const next = [...selectedFiles];
  for (const file of files) {
    if (next.length >= intakeConfig.maxFiles) break;
    const type = mimeForFile(file);
    if (!intakeConfig.allowedTypes.includes(type)) {
      showReceipt(`<strong>${escapeHtml(file.name)}</strong> is not an accepted file type.`, 'error');
      continue;
    }
    if (file.size < 1 || file.size > intakeConfig.maxFileBytes) {
      showReceipt(`<strong>${escapeHtml(file.name)}</strong> exceeds the ${humanBytes(intakeConfig.maxFileBytes)} per-file limit.`, 'error');
      continue;
    }
    if (!next.some((item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) next.push(file);
  }
  const total = next.reduce((sum, file) => sum + file.size, 0);
  if (total > intakeConfig.maxTotalBytes) {
    showReceipt(`Selected files exceed the ${humanBytes(intakeConfig.maxTotalBytes)} total request limit.`, 'error');
    return;
  }
  selectedFiles = next;
  renderFiles();
}

async function sha256(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function submitWorkRequest(event) {
  event.preventDefault();
  if (!requestForm || !intakeConfig?.enabled || !requestForm.reportValidity()) return;
  if (submitRequest) submitRequest.disabled = true;
  if (receipt) receipt.hidden = true;

  try {
    const form = new FormData(requestForm);
    const fileMetadata = [];
    for (let index = 0; index < selectedFiles.length; index += 1) {
      const file = selectedFiles[index];
      setProgress(Math.round((index / Math.max(selectedFiles.length, 1)) * 20), `Calculating SHA-256 · ${file.name}`);
      fileMetadata.push({ name: file.name, size: file.size, type: mimeForFile(file), sha256: await sha256(file) });
    }

    setProgress(22, 'Creating governed work request…');
    const start = await fetch('/work-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        requester: { name: form.get('name'), email: form.get('email'), organization: form.get('organization') },
        request: {
          serviceType: form.get('serviceType'), title: form.get('title'), description: form.get('description'),
          desiredOutcome: form.get('desiredOutcome'), targetDate: form.get('targetDate'),
        },
        authorizedToShare: form.get('authorizedToShare') === 'on',
        humanReviewAcknowledged: form.get('humanReviewAcknowledged') === 'on',
        files: fileMetadata,
      }),
    });
    const startBody = await start.json().catch(() => ({}));
    if (!start.ok) throw new Error(startBody.error || `request start failed (${start.status})`);

    startLiveTracking(startBody.requestId, startBody.uploadToken, false);

    for (let index = 0; index < selectedFiles.length; index += 1) {
      const file = selectedFiles[index];
      const remote = startBody.files[index];
      const percent = 25 + Math.round(((index + 1) / Math.max(selectedFiles.length, 1)) * 60);
      setProgress(percent, `Uploading to private quarantine · ${file.name}`);
      const upload = await fetch(`/work-requests/${encodeURIComponent(startBody.requestId)}/files/${encodeURIComponent(remote.fileId)}`, {
        method: 'PUT',
        headers: { 'content-type': mimeForFile(file), 'x-work-request-token': startBody.uploadToken, accept: 'application/json' },
        body: file,
      });
      const uploadBody = await upload.json().catch(() => ({}));
      if (!upload.ok) throw new Error(uploadBody.error || `upload failed for ${file.name} (${upload.status})`);
    }

    setProgress(92, 'Sealing request receipt…');
    const complete = await fetch(`/work-requests/${encodeURIComponent(startBody.requestId)}/complete`, {
      method: 'POST',
      headers: { 'x-work-request-token': startBody.uploadToken, accept: 'application/json' },
    });
    const completeBody = await complete.json().catch(() => ({}));
    if (!complete.ok) throw new Error(completeBody.error || `completion failed (${complete.status})`);

    setProgress(100, 'Work request received for human review.');
    showReceipt(`<strong>Request received.</strong><span>Reference: <code>${escapeHtml(completeBody.requestId)}</code></span><span>Status: received · unreviewed</span><span>The live processing window is tracking this request below.</span>`);
    requestForm.reset();
    selectedFiles = [];
    renderFiles();
    await pollProcessingStatus(true);
    if (processingConsole) processingConsole.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    setProgress(0, 'Submission stopped. No additional files will be uploaded.');
    showReceipt(`<strong>Work request not completed.</strong><span>${escapeHtml(error instanceof Error ? error.message : 'Unknown submission error')}</span>`, 'error');
  } finally {
    if (submitRequest) submitRequest.disabled = intakeConfig?.enabled !== true;
  }
}

if (fileInput) fileInput.addEventListener('change', () => addFiles(fileInput.files || []));
if (dropzone) {
  dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.dataset.dragging = 'true'; });
  dropzone.addEventListener('dragleave', () => { delete dropzone.dataset.dragging; });
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    delete dropzone.dataset.dragging;
    addFiles(event.dataTransfer?.files || []);
  });
}
if (requestForm) requestForm.addEventListener('submit', submitWorkRequest);
if (pauseUpdates) pauseUpdates.addEventListener('click', () => {
  tracking.paused = !tracking.paused;
  if (tracking.timer) clearTimeout(tracking.timer);
  tracking.timer = null;
  setText(processingLive, liveLabel(tracking.lastStatus));
  pauseUpdates.textContent = tracking.paused ? 'Resume live updates' : 'Pause live updates';
  if (!tracking.paused) pollProcessingStatus(true);
});
if (refreshProcessing) refreshProcessing.addEventListener('click', () => pollProcessingStatus(true));
if (copyReference) copyReference.addEventListener('click', async () => {
  if (!tracking.requestId) return;
  try {
    await navigator.clipboard.writeText(tracking.requestId);
    copyReference.textContent = 'Reference copied';
    setTimeout(() => { copyReference.textContent = 'Copy reference'; }, 1600);
  } catch {
    copyReference.textContent = tracking.requestId;
  }
});
if (downloadSnapshot) downloadSnapshot.addEventListener('click', () => {
  if (!tracking.lastStatus) return;
  const blob = new Blob([JSON.stringify(tracking.lastStatus, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${tracking.requestId || 'tmg-work-request'}-status.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
});
if (newRequest) newRequest.addEventListener('click', () => clearTracking());

syncStatus();
loadIntakeConfig();
restoreTracking();
setInterval(syncStatus, 60000);
