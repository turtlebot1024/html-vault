import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GitHubClient, configFromEnv } from "./core.js";
import { registerTools } from "./tools.js";

export interface Env {
  GITHUB_TOKEN: string; // server-side secret; never exposed to Claude
  VAULT_REPO: string;
  VAULT_PATH?: string;
  VAULT_BRANCH?: string;
  VAULT_READONLY?: string;
  MCP_OBJECT: DurableObjectNamespace;
}

/* ---------- MCP agent (Durable Object) ---------- */
export class HtmlVaultMCP extends McpAgent<Env> {
  server = new McpServer({ name: "html-vault", version: "1.1.0" });

  async init(): Promise<void> {
    const cfg = configFromEnv(this.env as unknown as Record<string, string | undefined>);
    registerTools(this.server, new GitHubClient(cfg));
  }
}

/* ---------- authless routing ----------
   Access control is the unguessable workers.dev URL. The data repo is reached
   with the GITHUB_TOKEN Worker secret, which is never sent to Claude.
   (To add a GitHub-login gate later, wrap these handlers in an OAuthProvider.) */
const mcpHandler = HtmlVaultMCP.serve("/mcp");
const sseHandler = HtmlVaultMCP.serveSSE("/sse");

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
      return mcpHandler.fetch(request, env, ctx);
    }
    if (pathname === "/sse" || pathname.startsWith("/sse/")) {
      return sseHandler.fetch(request, env, ctx);
    }
    return Promise.resolve(
      new Response("html-vault MCP server. Connect an MCP client to /mcp", { status: 404 })
    );
  },
};
