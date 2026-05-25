#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GitHubClient, configFromEnv } from "./core.js";
import { registerTools } from "./tools.js";

const cfg = configFromEnv(process.env);
const gh = new GitHubClient(cfg);

const server = new McpServer({ name: "html-vault", version: "1.1.0" });
registerTools(server, gh);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `html-vault MCP server (stdio) running (repo=${cfg.repo}, path=${cfg.path}, branch=${cfg.branch}, readonly=${cfg.readonly})`
);
