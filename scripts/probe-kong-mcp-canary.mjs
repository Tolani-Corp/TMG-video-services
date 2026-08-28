import fs from "node:fs";

const baseUrl = process.env.TMG_KONG_CANARY_URL?.replace(/\/$/, "");
const expectedSha = process.env.TMG_KONG_CANARY_SHA;
const output = process.env.TMG_KONG_CANARY_EVIDENCE ?? "tmg-kong-mcp-upstream-evidence.json";
const protocolVersion = "2026-07-28";
if (!baseUrl || !expectedSha) {
  console.error("TMG_KONG_CANARY_URL and TMG_KONG_CANARY_SHA are required");
  process.exit(2);
}

async function mcpPost(body, sessionId) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": protocolVersion,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(`${baseUrl}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  let payload = null;
  if (text.trim()) {
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).find(Boolean);
      if (data) payload = JSON.parse(data);
    } else {
      payload = JSON.parse(text);
    }
  }
  return { response, payload, text };
}

const healthResponse = await fetch(`${baseUrl}/health`, { headers: { accept: "application/json" } });
const health = await healthResponse.json();
if (!healthResponse.ok) throw new Error(`health failed: ${healthResponse.status}`);
if (health.deployedSha !== expectedSha) throw new Error(`deployed SHA mismatch: ${health.deployedSha} != ${expectedSha}`);
if (health.mcpEnabled !== true || health.publicApiEnabled !== false) throw new Error("runtime gate mismatch");
if (health.toolExecutionEnabled !== false || health.dataBindingsPresent !== false || health.productionAuthority !== false) throw new Error("authority guard mismatch");

const init = await mcpPost({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion, capabilities: {}, clientInfo: { name: "tmg-kong-canary", version: "1.0.0" } },
});
if (!init.response.ok || !init.payload?.result) throw new Error(`initialize failed: ${init.response.status} ${init.text.slice(0, 300)}`);
if (init.payload.result.protocolVersion !== protocolVersion) throw new Error(`protocol negotiation mismatch: ${init.payload.result.protocolVersion} != ${protocolVersion}`);
const sessionId = init.response.headers.get("mcp-session-id");

const initialized = await mcpPost({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
if (!initialized.response.ok) throw new Error(`initialized notification failed: ${initialized.response.status}`);

const tools = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId);
if (!tools.response.ok || !Array.isArray(tools.payload?.result?.tools)) throw new Error(`tools/list failed: ${tools.response.status} ${tools.text.slice(0, 300)}`);
const toolNames = tools.payload.result.tools.map((tool) => tool.name).sort();
if (JSON.stringify(toolNames) !== JSON.stringify(["search_video_moments"])) throw new Error(`unexpected tools: ${toolNames.join(",")}`);

const denied = await mcpPost({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_video_moments", arguments: {} } }, sessionId);
if (denied.response.status !== 403) throw new Error(`tools/call must fail 403 at upstream canary; got ${denied.response.status}`);

const evidence = {
  schema: "tolani.tmg.kong-mcp-upstream-evidence.v1",
  authority: "NON_PRODUCTION_DISCOVERY_ONLY",
  workerUrl: baseUrl,
  deployedSha: expectedSha,
  health,
  mcp: {
    initializeStatus: init.response.status,
    requestedProtocolVersion: protocolVersion,
    protocolVersion: init.payload.result.protocolVersion,
    sessionEstablished: Boolean(sessionId),
    toolsListStatus: tools.response.status,
    tools: toolNames,
    toolCallDeniedStatus: denied.response.status,
  },
  dataBindingsPresent: false,
  toolExecutionAuthorized: false,
  productionAuthority: false,
  rollbackRequired: true,
};
fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence, null, 2));
