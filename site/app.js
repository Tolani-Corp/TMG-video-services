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

let intakeConfig = null;
let selectedFiles = [];

function setText(node, value) {
  if (node) node.textContent = value;
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
      showReceipt(`<strong>${file.name}</strong> is not an accepted file type.`, 'error');
      continue;
    }
    if (file.size < 1 || file.size > intakeConfig.maxFileBytes) {
      showReceipt(`<strong>${file.name}</strong> exceeds the ${humanBytes(intakeConfig.maxFileBytes)} per-file limit.`, 'error');
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
    showReceipt(`<strong>Request received.</strong><span>Reference: <code>${completeBody.requestId}</code></span><span>Status: received · unreviewed</span><span>No processing or publication authority has been granted.</span>`);
    requestForm.reset();
    selectedFiles = [];
    renderFiles();
  } catch (error) {
    setProgress(0, 'Submission stopped. No additional files will be uploaded.');
    showReceipt(`<strong>Work request not completed.</strong><span>${error instanceof Error ? error.message : 'Unknown submission error'}</span>`, 'error');
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

syncStatus();
loadIntakeConfig();
setInterval(syncStatus, 60000);
