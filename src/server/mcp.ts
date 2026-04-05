import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadFromEnv } from "../config/connectionStore.js";
import { registerTools } from "./registerTools.js";
import { logger } from "../utils/logging.js";

async function main(): Promise<void> {
  loadFromEnv();

  const server = new McpServer({
    name: "chatgpt-imap",
    version: "1.0.0",
  });

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("MCP server started", {
    name: "chatgpt-imap",
    version: "1.0.0",
  });
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
