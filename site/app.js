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

function setText(node, value) {
  if (node) node.textContent = value;
}

function runtimeLabel(value) {
  if (value === true) return 'Enabled';
  if (value === false) return 'Gated';
  return 'Not exposed by current backend';
}

async function syncStatus() {
  try {
    const response = await fetch('/status.json', {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
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

syncStatus();
setInterval(syncStatus, 60000);
