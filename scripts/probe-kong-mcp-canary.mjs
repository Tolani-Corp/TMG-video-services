import fs from "node:fs";

const baseUrl = process.env.TMG_KONG_CANARY_URL?.replace(/\/$/, "");
const expectedSha = process.env.TMG_KONG_CANARY_SHA;
const output = process.env.TMG_KONG_CANARY_EVIDENCE ?? "tmg-kong-mcp-upstream-evidence.json";
const protocolVersion = "2026-07-28";
const clientInfo = { name: "tmg-kong-canary", version: "1.0.0" };
const clientCapabilities = {};

if (!baseUrl || !expectedSha) {
  console.error("TMG_KONG_CANARY_URL and TMG_KONG_CANARY_SHA are required");
  process.exit(2);
}

function requestMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": protocolVersion,
    "io.modelcontextprotocol/clientInfo": clientInfo,
    "io.modelcontextprotocol/clientCapabilities": clientCapabilities,
  };
}

async function mcpPost({ method, id, params = {}, name }) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": protocolVersion,
    "mcp-method": method,
  };
  if (name) headers["mcp-name"] = name;

  const body = {
    jsonrpc: "2.0",
    ...(id !== undefined ? { id } : {}),
    method,
    params: {
      ...params,
      _meta: requestMeta(),
    },
  };

  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  if (text.trim()) {
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const data = text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .find(Boolean);
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

const discover = await mcpPost({ method: "server/discover", id: "discover-1" });
if (!discover.response.ok || !discover.payload?.result) {
  throw new Error(`server/discover failed: ${discover.response.status} ${discover.text.slice(0, 300)}`);
}
const supportedVersions = Array.isArray(discover.payload.result.supportedVersions)
  ? [...discover.payload.result.supportedVersions]
  : [];
if (!supportedVersions.includes(protocolVersion)) {
  throw new Error(`server/discover did not advertise ${protocolVersion}: ${supportedVersions.join(",")}`);
}
if (!discover.payload.result.capabilities?.tools) {
  throw new Error("server/discover did not advertise tools capability");
}
if (discover.response.headers.get("mcp-session-id")) {
  throw new Error("modern MCP canary unexpectedly established a protocol session");
}

const tools = await mcpPost({ method: "tools/list", id: 2 });
if (!tools.response.ok || !Array.isArray(tools.payload?.result?.tools)) {
  throw new Error(`tools/list failed: ${tools.response.status} ${tools.text.slice(0, 300)}`);
}
const toolNames = tools.payload.result.tools.map((tool) => tool.name).sort();
if (JSON.stringify(toolNames) !== JSON.stringify(["search_video_moments"])) {
  throw new Error(`unexpected tools: ${toolNames.join(",")}`);
}
if (tools.response.headers.get("mcp-session-id")) {
  throw new Error("tools/list unexpectedly returned a protocol session");
}

const denied = await mcpPost({
  method: "tools/call",
  id: 3,
  name: "search_video_moments",
  params: { name: "search_video_moments", arguments: {} },
});
if (denied.response.status !== 403) {
  throw new Error(`tools/call must fail 403 at upstream canary; got ${denied.response.status}`);
}

const evidence = {
  schema: "tolani.tmg.kong-mcp-upstream-evidence.v1",
  authority: "NON_PRODUCTION_DISCOVERY_ONLY",
  workerUrl: baseUrl,
  deployedSha: expectedSha,
  health,
  mcp: {
    protocolVersion,
    protocolEra: "modern-stateless",
    discoveryStatus: discover.response.status,
    supportedVersions,
    serverCapabilities: discover.payload.result.capabilities,
    sessionEstablished: false,
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
