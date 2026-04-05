import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadFromEnv } from "../config/connectionStore.js";
import { logger } from "../utils/logging.js";
import { startHttp } from "./http.js";
import { registerTools } from "./registerTools.js";

async function startStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server started via stdio");
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "chatgpt-imap",
    version: "1.0.0",
  });

  registerTools(server);
  return server;
}

async function main(): Promise<void> {
  loadFromEnv();

  const transportMode = process.env.MCP_TRANSPORT ?? "stdio";

  if (transportMode !== "http" && transportMode !== "stdio") {
    logger.warn(
      `Unknown MCP_TRANSPORT value "${transportMode}"; defaulting to stdio`,
      {},
    );
  }

  if (transportMode === "http") {
    await startHttp(createMcpServer);
  } else {
    await startStdio(createMcpServer());
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
