import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { loadFromEnv } from "../config/connectionStore.js";
import { registerTools } from "./registerTools.js";
import { logger } from "../utils/logging.js";
import { timingSafeTokenEqual } from "../utils/crypto.js";

async function startStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server started via stdio");
}

async function startHttp(server: McpServer): Promise<void> {
  const rawPort = parseInt(process.env.MCP_PORT ?? "3000", 10);
  const port =
    Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535
      ? rawPort
      : (() => {
          logger.error("MCP_PORT is invalid; defaulting to 3000", {
            MCP_PORT: process.env.MCP_PORT,
          });
          return 3000;
        })();
  const authToken = process.env.MCP_AUTH_TOKEN;

  if (!authToken) {
    logger.error(
      "MCP_AUTH_TOKEN must be set when using HTTP transport",
      {}
    );
    process.exit(1);
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      if (req.url !== "/mcp" && !req.url?.startsWith("/mcp?")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not Found" }));
        return;
      }

      const authHeader = req.headers.authorization ?? "";
      const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
      if (!match || !timingSafeTokenEqual(match[1], authToken)) {
        res.writeHead(401, {
          "WWW-Authenticate": 'Bearer realm="mcp"',
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      try {
        await transport.handleRequest(req, res);
      } catch (e) {
        logger.error("HTTP request handling failed", { error: String(e) });
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal Server Error" }));
        }
      }
    }
  );

  await server.connect(transport);

  await new Promise<void>((resolve, reject) => {
    httpServer.on("error", reject);
    httpServer.listen(port, () => {
      logger.info("MCP server started via HTTP", {
        port,
        endpoint: "/mcp",
      });
      resolve();
    });
  });
}

async function main(): Promise<void> {
  loadFromEnv();

  const server = new McpServer({
    name: "chatgpt-imap",
    version: "1.0.0",
  });

  registerTools(server);

  const transportMode = process.env.MCP_TRANSPORT ?? "stdio";

  if (transportMode !== "http" && transportMode !== "stdio") {
    logger.warn(
      `Unknown MCP_TRANSPORT value "${transportMode}"; defaulting to stdio`,
      {}
    );
  }

  if (transportMode === "http") {
    await startHttp(server);
  } else {
    await startStdio(server);
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
