import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { mcpSearchInputSchema } from "./schemas";
import { searchVideoMoments } from "./vectorize";

function createVideoMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: "tmg-video-services",
    version: "0.1.0",
  });

  server.registerTool(
    "search_video_moments",
    {
      description:
        "Search rights-approved video moments in a tenant namespace. This tool never expands media rights and only returns segments explicitly granted for MCP retrieval.",
      inputSchema: mcpSearchInputSchema,
    },
    async ({ queryVector, topK, namespace, tenantId, territory }) => {
      const matches = await searchVideoMoments(env, {
        queryVector,
        topK,
        namespace,
        tenantId,
        purpose: "mcp",
        ...(territory ? { territory } : {}),
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ matches }),
          },
        ],
      };
    },
  );

  return server;
}

export function handleMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const handler = createMcpHandler(() => createVideoMcpServer(env), {
    route: "/mcp",
    legacy: "reject",
  });
  return handler(request, env, ctx);
}
