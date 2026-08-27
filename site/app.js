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

function gated(enabled) {
  return enabled ? 'Enabled' : 'Gated';
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

    if (syncRoot) syncRoot.dataset.syncState = healthy ? 'healthy' : 'degraded';
    setText(syncLabel, healthy ? 'Backend synchronized' : 'Backend degraded');
    setText(backendStatus, healthy ? 'Reachable via private Worker binding' : 'Degraded');
    setText(gate, status?.backend?.publicStatusGate ?? 'Unknown');
    setText(policy, status?.backend?.policyVersion ?? 'Unknown');
    setText(api, gated(status?.runtime?.publicApiEnabled));
    setText(mcp, gated(status?.runtime?.mcpEnabled));
    setText(ingestion, gated(status?.runtime?.ingestWorkflowEnabled));
    setText(egress, gated(status?.runtime?.externalProviderEgressEnabled));
    setText(syncedAt, status?.synchronizedAt ? new Date(status.synchronizedAt).toLocaleString() : 'Unknown');
  } catch {
    if (syncRoot) syncRoot.dataset.syncState = 'degraded';
    setText(syncLabel, 'Backend sync unavailable');
    setText(backendStatus, 'Unavailable');
  }
}

syncStatus();
setInterval(syncStatus, 60000);
